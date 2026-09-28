import { eq, sql } from 'drizzle-orm';
import type { AiCatalogItem } from '../ai/content-selection.js';
import type { MoiraiDatabase } from '../db/index.js';
import { mediaGroups, mediaItemGenres, mediaItems } from '../db/schema.js';

/** Keep local-only plot evidence small even when a source provides a long synopsis. */
const AI_LOCAL_PLOT_LENGTH = 500;

/** Read library identities, bounded local plot evidence, and hierarchy in two scoped queries. */
export async function readAiCatalog(db: MoiraiDatabase, libraryId: string): Promise<AiCatalogItem[]> {
	const rows = db.select({ id: mediaItems.id, title: mediaItems.title, year: mediaItems.year,
		kind: mediaItems.kind, groupId: mediaItems.groupId, season: mediaItems.seasonNumber, episode: mediaItems.episodeNumber,
		plot: sql<string | null>`substr(${mediaItems.plot}, 1, ${AI_LOCAL_PLOT_LENGTH})`,
		rating: sql<unknown>`json_extract(${mediaItems.metadata}, '$.rating')`.mapWith((value): number | null =>
			typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 10 ? value : null),
		keywords: sql<unknown>`json_extract(${mediaItems.metadata}, '$.tags')`.mapWith(value => {
			if (typeof value !== 'string') {
				return [];
			}
			try {
				return JSON.parse(value);
			}
			catch {
				return [value];
			}
		}),
		genres: sql<string>`(SELECT json_group_array(genre_name) FROM ${mediaItemGenres} WHERE item_id = ${mediaItems.id})`
			.mapWith((value: string): string[] => JSON.parse(value)),
	}).from(mediaItems).where(eq(mediaItems.libraryId, libraryId)).all();
	const groups = new Map(db.select({ id: mediaGroups.id, parentId: mediaGroups.parentId,
		title: mediaGroups.title, year: mediaGroups.year, kind: mediaGroups.kind,
	}).from(mediaGroups).where(eq(mediaGroups.libraryId, libraryId)).all().map(group => [group.id, group]));
	return rows.map(({ groupId, keywords, ...item }) => {
		let group = groupId ? groups.get(groupId) : undefined;
		const seen = new Set<string>();
		while (group && group.kind !== 'show' && !seen.has(group.id)) {
			seen.add(group.id);
			group = group.parentId ? groups.get(group.parentId) : undefined;
		}
		return { ...item, keywords: Array.isArray(keywords) ? keywords.filter((value): value is string => typeof value === 'string') : [],
			series: group?.kind === 'show' ? group.title : null, seriesYear: group?.kind === 'show' ? group.year : null };
	});
}
