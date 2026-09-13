import { eq, sql } from 'drizzle-orm';
import { programConfigSchema, type ResourceUsage, type SchedulingProgram } from '@moirai/shared';
import type { MoiraiDatabase } from '../db/index.js';
import { mediaItems, mediaItemAliases, schedulingPrograms } from '../db/schema.js';
import { compareLibraryQueryMedia, mediaMatchesLibraryQuery } from '../scheduling/content-query.js';
import type { SchedulingRepository } from './scheduling.js';

/**
 * Find programs that select an item directly, through its groups, or through a current library query.
 * Reuse the scheduling catalog and matching rules once for all queries in the item's library; query
 * limits apply before availability checks, so membership does not promise scheduled playback.
 */
export async function mediaResourceUsage(db: MoiraiDatabase, scheduling: SchedulingRepository, id: string, page: number, pageSize: number): Promise<ResourceUsage | null> {
	const item = db.select({ id: mediaItems.id, libraryId: mediaItems.libraryId, groupId: mediaItems.groupId })
		.from(mediaItems).where(eq(mediaItems.id, id)).get();
	if (!item) {
		return null;
	}

	// Resolve historical item identities and only this item's group ancestry, without per-owner reads.
	const ids = new Set([id, ...db.select({ id: mediaItemAliases.aliasId }).from(mediaItemAliases)
		.where(eq(mediaItemAliases.itemId, id)).all().map(row => row.id)]);
	const ancestors = new Set(db.all<{ id: string }>(sql`WITH RECURSIVE ancestors(id, parent_id) AS (
		SELECT id, parent_id FROM media_groups WHERE id = ${item.groupId}
		UNION SELECT g.id, g.parent_id FROM media_groups g JOIN ancestors a ON g.id = a.parent_id
	) SELECT id FROM ancestors`).map(row => row.id));
	const programs = db.select().from(schedulingPrograms)
		.where(sql`json_extract(${schedulingPrograms.config}, '$.type') = 'content' AND (
			json_extract(${schedulingPrograms.config}, '$.source.libraryId') = ${item.libraryId}
			OR json_extract(${schedulingPrograms.config}, '$.source.itemId') IN (SELECT value FROM json_each(${JSON.stringify([...ids])}))
			OR json_extract(${schedulingPrograms.config}, '$.source.groupId') IN (SELECT value FROM json_each(${JSON.stringify([...ancestors])}))
		)`).all();
	const owners: ResourceUsage['items'] = [];
	const queries: SchedulingProgram[] = [];
	for (const row of programs) {
		const parsed = programConfigSchema.safeParse(row.config);
		if (!parsed.success || parsed.data.type !== 'content') {
			continue;
		}
		const source = parsed.data.source;
		let role: string | null = null;
		if (source.type === 'item' && ids.has(source.itemId)) {
			role = 'Selected item';
		}
		else if (source.type === 'collection' && source.libraryId === item.libraryId && source.itemIds.some(value => ids.has(value))) {
			role = 'Selected items';
		}
		else if (source.type === 'group' && (source.includeDescendants ? ancestors.has(source.groupId) : source.groupId === item.groupId)) {
			role = 'Selected group';
		}
		else if (source.type === 'group-collection' && source.libraryId === item.libraryId && source.groupIds.some(value => ancestors.has(value))) {
			role = 'Selected groups';
		}
		else if (source.type === 'library-query' && source.libraryId === item.libraryId) {
			queries.push({ ...row, config: parsed.data });
		}
		if (role) {
			owners.push({ kind: 'program', id: row.id, name: row.name, roles: [role], referenceCount: 1 });
		}
	}

	// Load one shared library scope only when dynamic queries need evaluating, respecting sort limits.
	if (queries.length > 0) {
		const catalog = await scheduling.getSchedulingCatalog(queries);
		const media = catalog.mediaById?.get(id);
		if (media) {
			for (const program of queries) {
				if (program.config.type !== 'content' || program.config.source.type !== 'library-query') {
					continue;
				}
				const source = program.config.source;
				if (!mediaMatchesLibraryQuery(media, source)) {
					continue;
				}
				if (source.itemLimit != null) {
					const preceding = catalog.media.filter(candidate => mediaMatchesLibraryQuery(candidate, source)
						&& compareLibraryQueryMedia(candidate, media, source.sort) < 0).length;
					if (preceding >= source.itemLimit) {
						continue;
					}
				}
				owners.push({ kind: 'program', id: program.id, name: program.name, roles: ['Matching library query'], referenceCount: 1 });
			}
		}
	}

	owners.sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }) || left.id.localeCompare(right.id));
	return { total: owners.length, items: owners.slice((page - 1) * pageSize, page * pageSize) };
}
