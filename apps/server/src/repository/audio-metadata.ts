import { inArray } from 'drizzle-orm';
import type { MoiraiDatabase } from '../db/index.js';
import { mediaItems } from '../db/schema.js';

/** Load stream metadata by physical playback path only for referenced media. */
export async function audioMetadata(database: MoiraiDatabase, ids: string[]): Promise<Map<string, unknown>> {
	const result = new Map<string, unknown>();
	const unique = [...new Set(ids)];
	for (let offset = 0; offset < unique.length; offset += 500) {
		const rows = await database.select({ path: mediaItems.playbackPath, parts: mediaItems.parts, metadata: mediaItems.technicalMetadata })
			.from(mediaItems).where(inArray(mediaItems.id, unique.slice(offset, offset + 500)));
		for (const row of rows) {
			const metadata = row.metadata ?? {};
			if (row.parts.length && Array.isArray(metadata.parts)) {
				for (const [index, part] of row.parts.entries()) {
					result.set(part.playbackPath, metadata.parts[index]);
				}
			}
			else if (!row.parts.length) {
				result.set(row.path, metadata);
			}
		}
	}
	return result;
}
