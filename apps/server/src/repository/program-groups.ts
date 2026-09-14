import { eq, inArray, and } from 'drizzle-orm';
import { MAX_EXPLICIT_MEDIA_GROUPS, programConfigSchema, type ProgramGroupAdditionResult } from '@moirai/shared';
import type { MoiraiDatabase } from '../db/index.js';
import { mediaGroups, schedulingPrograms } from '../db/schema.js';
import { currentTimestamp } from '../time.js';

/** Outcome of validating and merging selected hierarchy groups in a single transaction. */
type GroupAppendResult = { status: 'not-found' | 'incompatible' | 'invalid-groups' | 'capacity' }
	| ({ status: 'updated' } & ProgramGroupAdditionResult);

/** Append only missing same-library groups while preserving program settings and authored order. */
export function appendProgramGroups(db: MoiraiDatabase, id: string, libraryId: string, groupIds: string[]): GroupAppendResult {
	return db.transaction((tx): GroupAppendResult => {
		const row = tx.select().from(schedulingPrograms).where(eq(schedulingPrograms.id, id)).get();
		if (!row) {
			return { status: 'not-found' };
		}
		const config = programConfigSchema.parse(row.config);
		if (config.type !== 'content' || config.source.type !== 'group-collection' || config.source.libraryId !== libraryId) {
			return { status: 'incompatible' };
		}

		const incoming = [...new Set(groupIds)];
		const groups = tx.select({ id: mediaGroups.id }).from(mediaGroups)
			.where(and(eq(mediaGroups.libraryId, libraryId), inArray(mediaGroups.id, incoming))).all();
		if (groups.length !== incoming.length) {
			return { status: 'invalid-groups' };
		}
		const current = new Set(config.source.groupIds);
		const additions = incoming.filter(groupId => !current.has(groupId));
		if (current.size + additions.length > MAX_EXPLICIT_MEDIA_GROUPS) {
			return { status: 'capacity' };
		}
		config.source.groupIds.push(...additions);
		const updatedAt = additions.length ? currentTimestamp() : row.updatedAt;
		if (additions.length) {
			tx.update(schedulingPrograms).set({ config, updatedAt }).where(eq(schedulingPrograms.id, id)).run();
		}
		return {
			status: 'updated', created: false,
			program: { id: row.id, name: row.name, config, createdAt: row.createdAt, updatedAt },
			addedGroupCount: additions.length, alreadySelectedCount: incoming.length - additions.length,
		};
	});
}
