import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { SchedulingCatalog, SelectionStateRecord } from '@moirai/shared';
import type { MoiraiDatabase } from '../db/index.js';
import { mediaItemAliases } from '../db/schema.js';

/** Resolve a bounded batch through the alias primary key. */
export async function resolveSchedulingMediaAliases(db: MoiraiDatabase, ids: string[]): Promise<Array<{ aliasId: string; itemId: string }>> {
	return db.select({ aliasId: mediaItemAliases.aliasId, itemId: mediaItemAliases.itemId })
		.from(mediaItemAliases)
		.where(sql`${mediaItemAliases.aliasId} IN (SELECT value FROM json_each(${JSON.stringify(ids)}))`);
}

/** Resolve missing sequential cursor IDs without expanding the cached media scope. */
export async function withSchedulingCursorAliases(db: MoiraiDatabase, catalog: SchedulingCatalog, state: Iterable<SelectionStateRecord>): Promise<SchedulingCatalog> {
	const requested = new Set<string>();
	for (const { value } of state) {
		if (value.type === 'sequential' && value.lastItemId && !catalog.mediaAliases?.[value.lastItemId]) {
			requested.add(value.lastItemId);
		}
	}
	if (!requested.size) {
		return catalog;
	}

	const byId = catalog.mediaById ?? new Map(catalog.media.map(media => [media.id, media]));
	const unresolved = [...requested].filter(id => !byId.has(id));
	if (!unresolved.length) {
		return catalog;
	}
	const rows = await resolveSchedulingMediaAliases(db, unresolved);
	const aliases = rows.filter(({ itemId }) => byId.has(itemId));
	if (!aliases.length) {
		return catalog;
	}

	aliases.sort((left, right) => left.aliasId.localeCompare(right.aliasId));
	return {
		...catalog,
		mediaAliases: { ...catalog.mediaAliases, ...Object.fromEntries(aliases.map(({ aliasId, itemId }) => [aliasId, itemId])) },
		...(catalog.cacheKey ? { cacheKey: `${catalog.cacheKey}:cursors:${createHash('sha256').update(JSON.stringify(aliases)).digest('hex')}` } : {}),
	};
}
