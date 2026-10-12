import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { GUIDE_ARTWORK_MAX_BYTES, GUIDE_ARTWORK_MAX_DIMENSION, type ScheduleSlot } from '@moirai/shared';

/** Allow interrupted saves one day before removing their unreferenced uploads. */
export const GUIDE_ARTWORK_GRACE_MS = 24 * 60 * 60 * 1000;

/** Report an invalid custom block image or a missing managed reference. */
export class GuideArtworkValidationError extends Error {}

/** Collect distinct artwork references without depending on slot or template ownership. */
export function guideArtworkIds(slots: ScheduleSlot[]): Set<string> {
	return new Set(slots.flatMap(slot => slot.guide?.mode === 'block' && slot.guide.artworkId
		? [slot.guide.artworkId] : []));
}

/** Decode bounded raster input, remove metadata, and preserve its aspect ratio as PNG. */
export async function normalizeGuideArtwork(content: Buffer): Promise<Buffer> {
	if (content.length > GUIDE_ARTWORK_MAX_BYTES) {
		throw new GuideArtworkValidationError('Guide artwork exceeds the upload size limit');
	}

	try {
		const options = { failOn: 'error' as const, limitInputPixels: GUIDE_ARTWORK_MAX_DIMENSION ** 2 };
		const metadata = await sharp(content, options).metadata();
		if (!['png', 'jpeg', 'webp'].includes(metadata.format ?? '') || (metadata.pages ?? 1) !== 1
			|| !metadata.width || !metadata.height
			|| metadata.width > GUIDE_ARTWORK_MAX_DIMENSION || metadata.height > GUIDE_ARTWORK_MAX_DIMENSION) {
			throw new Error('Invalid format or dimensions');
		}

		const normalized = await sharp(content, options).rotate().png().toBuffer();
		if (normalized.length > GUIDE_ARTWORK_MAX_BYTES) {
			throw new GuideArtworkValidationError('Normalized guide artwork exceeds the size limit');
		}
		return normalized;
	}
	catch (error) {
		if (error instanceof GuideArtworkValidationError) {
			throw error;
		}
		throw new GuideArtworkValidationError(`Choose a valid, still PNG, JPEG, or WebP image up to ${GUIDE_ARTWORK_MAX_DIMENSION} pixels per dimension`);
	}
}

/**
 * Own immutable block images outside the media catalog. Template writes and orphan reconciliation
 * share a queue so cleanup cannot remove a reference while a save is committing it.
 */
export class GuideArtworkStore {
	private pending: Promise<unknown> = Promise.resolve();

	constructor(private readonly root: string) {}

	/** Resolve a validated UUID inside managed storage. */
	private pathFor(id: string): string {
		if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
			throw new GuideArtworkValidationError('Invalid guide artwork identifier');
		}
		return path.join(this.root, `${id}.png`);
	}

	/** Serialize rare configuration writes and cleanup without blocking guide reads. */
	mutate<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.pending.then(operation);
		this.pending = result.catch(() => undefined);
		return result;
	}

	/** Publish a fully validated image using a fresh immutable identity. */
	async upload(content: Buffer): Promise<string> {
		const normalized = await normalizeGuideArtwork(content);
		await mkdir(this.root, { recursive: true });
		const id = randomUUID();
		const temporary = `${this.pathFor(id)}.tmp`;
		try {
			await writeFile(temporary, normalized);
			await rename(temporary, this.pathFor(id));
		}
		finally {
			await unlink(temporary).catch(() => undefined);
		}
		return id;
	}

	/** Check references only on configuration writes or explicit asset retrieval. */
	async exists(id: string): Promise<boolean> {
		try {
			return (await stat(this.pathFor(id))).isFile();
		}
		catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
				return false;
			}
			throw error;
		}
	}

	/** Stream normalized PNG content without loading it into the guide catalog. */
	stream(id: string) {
		return createReadStream(this.pathFor(id));
	}

	/** Remove old unreferenced images and interrupted temporary writes while holding the queue. */
	async reconcile(loadReferences: () => Promise<ReadonlySet<string>>, now = Date.now()): Promise<void> {
		let names: string[];
		try {
			names = await readdir(this.root);
		}
		catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
				return;
			}
			throw error;
		}

		// Load persisted references only when an old managed file could need cleanup.
		const candidates: Array<{ id: string; filename: string }> = [];
		for (const name of names) {
			const match = /^([0-9a-f-]{36})\.png(?:\.tmp)?$/.exec(name);
			if (!match) {
				continue;
			}
			const filename = path.join(this.root, name);
			if (now - (await stat(filename)).mtimeMs >= GUIDE_ARTWORK_GRACE_MS) {
				candidates.push({ id: match[1]!, filename });
			}
		}
		if (!candidates.length) {
			return;
		}

		const referenced = await loadReferences();
		for (const candidate of candidates) {
			if (!referenced.has(candidate.id)) {
				await unlink(candidate.filename);
			}
		}
	}
}
