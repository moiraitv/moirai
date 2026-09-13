import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { CREDIT_PREVIEW_VIDEO_LIMIT, canonicalIdentityKey, type CreditTemplate, type CreditTemplateCreate, type MediaItem } from '@moirai/shared';
import type { MoiraiDatabase } from '../db/index.js';
import { creditTemplates, channels, schedulingPrograms, mediaItems } from '../db/schema.js';
import { mappedItem, type RawItemRow } from './catalog-records.js';
import { currentTimestamp } from '../time.js';

/** A template conflict or invalid reference that callers can present without database details. */
export class CreditTemplateError extends Error {
	constructor(message: string, readonly statusCode = 409) {
		super(message);
	}
}

/** Own reusable credit templates and bounded playback metadata lookups. */
export class CreditTemplateRepository {
	constructor(private readonly db: MoiraiDatabase) {}

	/** List templates in display order without exposing canonical comparison keys. */
	async list(): Promise<CreditTemplate[]> {
		return this.db.select({ id: creditTemplates.id, name: creditTemplates.name, source: creditTemplates.source,
			description: creditTemplates.description, isBuiltin: creditTemplates.isBuiltin,
			createdAt: creditTemplates.createdAt, updatedAt: creditTemplates.updatedAt })
			.from(creditTemplates).orderBy(desc(creditTemplates.isBuiltin), asc(creditTemplates.name));
	}

	/** Create or replace a named template while retaining its stable identity. */
	async save(input: CreditTemplateCreate, id?: string): Promise<CreditTemplate> {
		return this.db.transaction((tx) => {
			const current = id ? tx.select().from(creditTemplates).where(eq(creditTemplates.id, id)).get() : null;
			if (id && !current) {
				throw new CreditTemplateError('Credit template not found', 404);
			}
			if (current?.isBuiltin) {
				throw new CreditTemplateError('Built-in templates cannot be edited; duplicate one to customize it');
			}
			const nameKey = canonicalIdentityKey(input.name);
			const conflict = tx.select().from(creditTemplates).where(eq(creditTemplates.nameKey, nameKey)).get();
			if (conflict && conflict.id !== id) {
				throw new CreditTemplateError('A credit template with that name already exists');
			}
			const timestamp = currentTimestamp();
			const result = { ...input, isBuiltin: false, id: id ?? randomUUID(), createdAt: current?.createdAt ?? timestamp, updatedAt: timestamp };
			if (id) {
				tx.update(creditTemplates).set({ ...result, nameKey }).where(eq(creditTemplates.id, id)).run();
			}
			else {
				tx.insert(creditTemplates).values({ ...result, nameKey }).run();
			}
			return result;
		});
	}

	/** Delete only unreferenced templates, preserving channel and program configuration. */
	async delete(id: string): Promise<void> {
		this.db.transaction((tx) => {
			const template = tx.select().from(creditTemplates).where(eq(creditTemplates.id, id)).get();
			if (template?.isBuiltin) {
				throw new CreditTemplateError('Built-in templates cannot be deleted');
			}
			const channel = tx.select().from(channels).all().find((row) => row.config.subtitlePreferences?.creditsTemplateId === id);
			const program = tx.select().from(schedulingPrograms).all().find((row) => row.config.subtitlePreferences?.creditsTemplateId === id);
			if (channel || program) {
				throw new CreditTemplateError(`Credit template is used by ${channel ? 'channel ' + channel.name : 'program ' + program!.name}`);
			}
			const removed = tx.delete(creditTemplates).where(eq(creditTemplates.id, id)).run();
			if (!removed.changes) {
				throw new CreditTemplateError('Credit template not found', 404);
			}
		});
	}

	/** Offer a bounded, deterministic sample of available music videos across libraries. */
	async previewVideos(): Promise<MediaItem[]> {
		const rows = await this.db.select().from(mediaItems)
			.where(and(eq(mediaItems.kind, 'music-video'), eq(mediaItems.availability, 'available')))
			.orderBy(desc(mediaItems.dateAddedAt), asc(mediaItems.id)).limit(CREDIT_PREVIEW_VIDEO_LIMIT);
		return rows.map(row => mappedItem(row as RawItemRow));
	}

	/** Load only media used by the pending playout, with bounded SQLite parameter batches. */
	async media(ids: string[]): Promise<Map<string, MediaItem>> {
		const result = new Map<string, MediaItem>();
		const unique = [...new Set(ids)];
		for (let offset = 0; offset < unique.length; offset += 500) {
			const rows = await this.db.select().from(mediaItems).where(inArray(mediaItems.id, unique.slice(offset, offset + 500)));
			for (const row of rows) {
				result.set(row.id, mappedItem(row as RawItemRow));
			}
		}
		return result;
	}
}
