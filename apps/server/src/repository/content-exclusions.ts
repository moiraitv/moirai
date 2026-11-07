import { contentExclusionsSchema, mergeContentExclusions, type ContentExclusions, type ProgramConfig } from '@moirai/shared';
import { or, sql, type SQL } from 'drizzle-orm';
import type { MoiraiDatabase } from '../db/index.js';
import { mediaItems } from '../db/schema.js';
import { SchedulingValidationError } from '../scheduling/validation.js';

/** Match excluded items, aliases and descendant groups inside an indexed library query. */
export function excludedMediaPredicate(libraryId: string, exclusions?: ContentExclusions): SQL | undefined {
	const items = exclusions?.itemIds ?? [];
	const groups = exclusions?.groupIds ?? [];
	const item = items.length ? sql`${mediaItems.id} IN (
		WITH requested(id) AS (SELECT value FROM json_each(${JSON.stringify(items)}))
		SELECT id FROM requested UNION SELECT item_id FROM media_item_aliases WHERE alias_id IN (SELECT id FROM requested)
	)` : undefined;
	const group = groups.length ? sql`coalesce(${mediaItems.groupId} IN (
		WITH RECURSIVE excluded(id) AS (
			SELECT id FROM media_groups WHERE library_id = ${libraryId} AND id IN (SELECT value FROM json_each(${JSON.stringify(groups)}))
			UNION SELECT g.id FROM media_groups g JOIN excluded e ON g.parent_id = e.id WHERE g.library_id = ${libraryId}
		) SELECT id FROM excluded
	), 0)` : undefined;
	return or(item, group);
}

/** Keep empty exclusion lists equivalent to legacy programs and persist stable set ordering. */
export function normalizeContentExclusions(config: ProgramConfig): ProgramConfig {
	if (config.type !== 'content' || !('exclusions' in config.source) || !config.source.exclusions) {
		return config;
	}

	const { exclusions: input, ...source } = config.source;
	const exclusions = contentExclusionsSchema.parse(input);
	return { ...config, source: { ...source, ...(exclusions.itemIds.length || exclusions.groupIds.length ? { exclusions } : {}) } };
}

/** Require newly excluded references to belong to the source library in the write transaction. */
export function validateContentExclusions(db: Pick<MoiraiDatabase, 'all'>, current: ProgramConfig | undefined, config: ProgramConfig): void {
	if (config.type !== 'content' || !('exclusions' in config.source) || !config.source.exclusions) {
		return;
	}

	const { libraryId, exclusions } = config.source;
	const priorSource = current?.type === 'content' ? current.source : undefined;
	const prior = mergeContentExclusions(
		priorSource && 'exclusions' in priorSource ? priorSource.exclusions : undefined,
		priorSource?.type === 'ai' ? priorSource.excludedItemIds : undefined,
	);
	const priorItems = new Set(prior?.itemIds);
	const priorGroups = new Set(prior?.groupIds);
	const items = exclusions.itemIds.filter(id => !priorItems.has(id));
	const groups = exclusions.groupIds.filter(id => !priorGroups.has(id));
	if (items.length) {
		const ids = db.all<{ id: string }>(sql`WITH requested(id) AS (SELECT value FROM json_each(${JSON.stringify(items)}))
			SELECT requested.id FROM requested JOIN media_items i ON i.id = requested.id WHERE i.library_id = ${libraryId}
			UNION SELECT requested.id FROM requested JOIN media_item_aliases a ON a.alias_id = requested.id
			JOIN media_items i ON i.id = a.item_id WHERE i.library_id = ${libraryId}`);
		if (ids.length !== items.length) {
			throw new SchedulingValidationError('Excluded items must be indexed in the Program library');
		}
	}
	if (groups.length) {
		const ids = db.all<{ id: string }>(sql`SELECT id FROM media_groups WHERE library_id = ${libraryId}
			AND id IN (SELECT value FROM json_each(${JSON.stringify(groups)}))`);
		if (ids.length !== groups.length) {
			throw new SchedulingValidationError('Excluded groups must be indexed in the Program library');
		}
	}
}
