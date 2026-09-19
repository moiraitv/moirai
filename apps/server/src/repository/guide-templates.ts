import { randomUUID } from 'node:crypto';
import { asc, desc, eq, sql } from 'drizzle-orm';
import {
	BUILTIN_GUIDE_TEMPLATE,
	canonicalIdentityKey,
	emptyGuideTemplateSources,
	guideTemplateSourcesSchema,
	type ChannelCreate,
	type GuideTemplate,
	type GuideTemplateCreate,
	type GuideTemplateSources,
} from '@moirai/shared';
import type { MoiraiDatabase } from '../db/index.js';
import { channels, guideTemplates } from '../db/schema.js';
import { currentTimestamp } from '../time.js';

/** A template conflict or invalid reference safe to display to administrators. */
export class GuideTemplateError extends Error {
	constructor(message: string, readonly statusCode = 409) {
		super(message);
	}
}

/** Present a stored row, overlaying the built-in sources so upgrades stay current. */
function mappedTemplate(row: typeof guideTemplates.$inferSelect): GuideTemplate {
	const parsed = guideTemplateSourcesSchema.safeParse(row.sources);
	const sources = parsed.success ? parsed.data : emptyGuideTemplateSources();
	return {
		id: row.id,
		name: row.name,
		description: row.description,
		sources: row.isBuiltin && row.id === BUILTIN_GUIDE_TEMPLATE.id
			? BUILTIN_GUIDE_TEMPLATE.sources
			: sources,
		isBuiltin: row.isBuiltin,
		isDefault: row.isDefault,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

/** Reject unknown guide-template assignments during a channel write. */
export function validateGuideTemplateReference(
	db: Pick<MoiraiDatabase, 'select'>,
	config: Pick<ChannelCreate, 'guideTemplateId'>,
): void {
	if (!config.guideTemplateId) {
		return;
	}

	const template = db.select({ id: guideTemplates.id })
		.from(guideTemplates)
		.where(eq(guideTemplates.id, config.guideTemplateId))
		.get();
	if (!template) {
		throw new GuideTemplateError('Selected guide template does not exist', 400);
	}
}

/**
 * Own reusable XMLTV templates, the single default assignment, and channel references.
 * Built-in sources are supplied from the application constant so layout upgrades do not
 * require rewriting stored rows.
 */
export class GuideTemplateRepository {
	constructor(private readonly db: MoiraiDatabase) {}

	/** List templates with built-in entries first, then by display name. */
	async list(): Promise<GuideTemplate[]> {
		return this.db.select().from(guideTemplates)
			.orderBy(desc(guideTemplates.isBuiltin), asc(guideTemplates.name))
			.all()
			.map(mappedTemplate);
	}

	/** Return the saved default used when a channel does not assign a template. */
	async getDefault(): Promise<GuideTemplate> {
		const row = this.db.select().from(guideTemplates).where(eq(guideTemplates.isDefault, true)).get();
		if (!row) {
			throw new GuideTemplateError('Default guide template is unavailable', 503);
		}

		return mappedTemplate(row);
	}

	/** Return one template by identity, or null when it does not exist. */
	async get(id: string): Promise<GuideTemplate | null> {
		const row = this.db.select().from(guideTemplates).where(eq(guideTemplates.id, id)).get();
		return row ? mappedTemplate(row) : null;
	}

	/** Create or replace a named template while retaining its stable identity. */
	async save(input: GuideTemplateCreate, id?: string): Promise<GuideTemplate> {
		return this.db.transaction((tx) => {
			const current = id ? tx.select().from(guideTemplates).where(eq(guideTemplates.id, id)).get() : null;
			if (id && !current) {
				throw new GuideTemplateError('Guide template not found', 404);
			}
			if (current?.isBuiltin) {
				throw new GuideTemplateError('Built-in templates cannot be edited; duplicate one to customize it');
			}

			const nameKey = canonicalIdentityKey(input.name);
			const conflict = tx.select().from(guideTemplates).where(eq(guideTemplates.nameKey, nameKey)).get();
			if (conflict && conflict.id !== id) {
				throw new GuideTemplateError('A guide template with that name already exists');
			}

			const timestamp = currentTimestamp();
			const sources = guideTemplateSourcesSchema.parse(input.sources);
			const result: GuideTemplate = {
				...input,
				sources,
				isBuiltin: false,
				isDefault: current?.isDefault ?? false,
				id: id ?? randomUUID(),
				createdAt: current?.createdAt ?? timestamp,
				updatedAt: timestamp,
			};
			if (id) {
				tx.update(guideTemplates).set({
					name: result.name,
					nameKey,
					description: result.description,
					sources,
					updatedAt: timestamp,
				}).where(eq(guideTemplates.id, id)).run();
			}
			else {
				tx.insert(guideTemplates).values({
					id: result.id,
					name: result.name,
					nameKey,
					description: result.description,
					sources,
					isBuiltin: false,
					isDefault: false,
					createdAt: result.createdAt,
					updatedAt: timestamp,
				}).run();
			}

			return result;
		});
	}

	/** Atomically switch the default used by unassigned channels. */
	async setDefault(id: string): Promise<GuideTemplate> {
		return this.db.transaction((tx) => {
			const row = tx.select().from(guideTemplates).where(eq(guideTemplates.id, id)).get();
			if (!row) {
				throw new GuideTemplateError('Guide template not found', 404);
			}

			tx.update(guideTemplates).set({ isDefault: false }).where(eq(guideTemplates.isDefault, true)).run();
			tx.update(guideTemplates).set({ isDefault: true }).where(eq(guideTemplates.id, id)).run();
			return mappedTemplate({ ...row, isDefault: true });
		});
	}

	/** Reject deletion until channels have chosen another template or the default. */
	async delete(id: string): Promise<void> {
		this.db.transaction((tx) => {
			const template = tx.select().from(guideTemplates).where(eq(guideTemplates.id, id)).get();
			if (template?.isBuiltin || template?.isDefault) {
				throw new GuideTemplateError(template.isBuiltin
					? 'Built-in templates cannot be deleted'
					: 'Choose another default before deleting this template');
			}

			const linked = tx.select({ name: channels.name }).from(channels)
				.where(sql`json_extract(${channels.config}, '$.guideTemplateId') = ${id}`)
				.limit(1)
				.get();
			if (linked) {
				throw new GuideTemplateError(`Guide template is used by channel ${linked.name}`);
			}

			if (!tx.delete(guideTemplates).where(eq(guideTemplates.id, id)).run().changes) {
				throw new GuideTemplateError('Guide template not found', 404);
			}
		});
	}

	/** Resolve the Liquid sources a channel should use for XMLTV generation. */
	async sourcesForChannel(channel: Pick<ChannelCreate, 'guideTemplateId'>): Promise<GuideTemplateSources> {
		if (channel.guideTemplateId) {
			const assigned = await this.get(channel.guideTemplateId);
			if (assigned) {
				return assigned.sources;
			}
		}

		return (await this.getDefault()).sources;
	}

	/** Load every template once so a published XMLTV document can assign per channel. */
	async sourcesById(): Promise<{
		defaultSources: GuideTemplateSources;
		byId: Map<string, GuideTemplateSources>;
	}> {
		const templates = await this.list();
		const defaultTemplate = templates.find((entry) => entry.isDefault);
		if (!defaultTemplate) {
			throw new GuideTemplateError('Default guide template is unavailable', 503);
		}

		return {
			defaultSources: defaultTemplate.sources,
			byId: new Map(templates.map((entry) => [entry.id, entry.sources])),
		};
	}
}
