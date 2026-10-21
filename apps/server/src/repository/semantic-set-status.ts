import type { SelectionStateRecord, SimilaritySetStatus } from '@moirai/shared';
import type { MoiraiDatabase } from '../db/index.js';

/** One committed consumer with current removals and only the aliases needed to compare them. */
interface CurrentSetRow {
	value: string;
	channelName: string;
	excludedItemIds: string | null;
	aliases: string;
}

/** Count unconsumed, allowed entries without rewriting immutable sets or their consumption history. */
export function currentSemanticSets(db: MoiraiDatabase, programIds?: string[]): SimilaritySetStatus[] {
	const rows = db.$client.prepare(`
		SELECT s.value, c.name AS channelName,
			json_extract(p.config, '$.excludedItemIds') AS excludedItemIds,
			CASE WHEN json_array_length(p.config, '$.excludedItemIds') > 0 THEN (
				SELECT json_group_object(alias_id, item_id) FROM media_item_aliases
				WHERE alias_id IN (
					SELECT value FROM json_each(p.config, '$.excludedItemIds')
					UNION SELECT value FROM json_each(s.value, '$.seed.itemIds')
				)
			) ELSE '{}' END AS aliases
		FROM selection_states s
		JOIN channels c ON c.id = s.channel_id
		LEFT JOIN scheduling_programs p ON p.id = json_extract(s.value, '$.seed.programId')
		WHERE json_extract(s.value, '$.type') = 'similarity'
			AND (? IS NULL OR json_extract(s.value, '$.seed.programId') IN (SELECT value FROM json_each(?)))
	`).all(programIds ? JSON.stringify(programIds) : null, programIds ? JSON.stringify(programIds) : null) as CurrentSetRow[];

	return rows.map((row) => {
		const value = JSON.parse(row.value) as Extract<SelectionStateRecord['value'], { type: 'similarity' }>;
		const aliases = JSON.parse(row.aliases) as Record<string, string>;
		const excluded = new Set((JSON.parse(row.excludedItemIds ?? '[]') as string[]).map((id) => aliases[id] ?? id));
		const consumed = new Set(value.consumedItemIds);
		return {
			channelName: row.channelName, programId: value.seed.programId, consumerKey: value.seed.consumerKey,
			generation: value.seed.generation, total: value.seed.itemIds.length, requestedTotal: value.seed.config.quantity,
			remaining: value.seed.itemIds.filter((id) => !consumed.has(id) && !excluded.has(aliases[id] ?? id)).length,
		};
	});
}
