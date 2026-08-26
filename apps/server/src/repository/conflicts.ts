import {
	canonicalChannelNumberKey,
	canonicalIdentityKey,
	type DataConflict,
	type DataConflictReport,
} from '@moirai/shared';
import type { MoiraiDatabase } from '../db/index.js';
import {
	catalogConflicts,
	channels,
	libraries,
	scheduleTemplates,
	schedulingPrograms,
} from '../db/schema.js';

/** Maximum conflicts returned by the status API. */
const MAX_STATUS_CONFLICTS = 100;

/** Append canonical duplicate groups from one resource table. */
function appendDuplicateConflicts(
	conflicts: DataConflict[],
	rows: Array<{ id: string; value: string; createdAt: string }>,
	resourceType: 'library' | 'program' | 'template' | 'channel',
	keyFor: (value: string) => string,
): void {
	const rowsByKey = new Map<string, typeof rows>();
	for (const row of rows) {
		const key = keyFor(row.value);
		const matching = rowsByKey.get(key) ?? [];
		matching.push(row);
		rowsByKey.set(key, matching);
	}
	for (const [key, matching] of rowsByKey) {
		if (matching.length < 2) {
			continue;
		}

		const isChannel = resourceType === 'channel';
		conflicts.push({
			id: `${resourceType}:${key}`,
			kind: isChannel ? 'channel-number' : 'resource-name',
			severity: isChannel ? 'error' : 'warning',
			resourceType,
			resourceId: matching[0]?.id ?? null,
			libraryId: resourceType === 'library' ? (matching[0]?.id ?? null) : null,
			title: isChannel ? 'Duplicate channel number' : `Duplicate ${resourceType} name`,
			message: `${matching.length} ${resourceType}${matching.length === 1 ? '' : 's'} share the same canonical ${isChannel ? 'number' : 'name'}.`,
			paths: matching.map((row) => row.value).slice(0, 10),
			observedAt: matching.map((row) => row.createdAt).sort()[0] ?? null,
		});
	}
}

/** Load bounded source and resource-identity conflicts for the Status page. */
export async function listDataConflicts(db: MoiraiDatabase): Promise<DataConflictReport> {
	const [catalogRows, libraryRows, programRows, templateRows, channelRows] = await Promise.all([
		db.select().from(catalogConflicts),
		db.select({ id: libraries.id, value: libraries.name, createdAt: libraries.createdAt }).from(libraries),
		db.select({ id: schedulingPrograms.id, value: schedulingPrograms.name, createdAt: schedulingPrograms.createdAt }).from(schedulingPrograms),
		db.select({ id: scheduleTemplates.id, value: scheduleTemplates.name, createdAt: scheduleTemplates.createdAt }).from(scheduleTemplates),
		db.select({ id: channels.id, value: channels.number, createdAt: channels.createdAt }).from(channels),
	]);
	const conflicts: DataConflict[] = catalogRows.map((row) => ({
		id: `${row.libraryId}:${row.conflictKey}`,
		kind: 'show-external-id',
		severity: 'warning',
		resourceType: 'library',
		resourceId: row.libraryId,
		libraryId: row.libraryId,
		title: 'Show metadata ID is reused',
		message: row.message,
		paths: row.paths.slice(0, 10),
		observedAt: row.observedAt,
	}));
	appendDuplicateConflicts(conflicts, libraryRows, 'library', canonicalIdentityKey);
	appendDuplicateConflicts(conflicts, programRows, 'program', canonicalIdentityKey);
	appendDuplicateConflicts(conflicts, templateRows, 'template', canonicalIdentityKey);
	appendDuplicateConflicts(conflicts, channelRows, 'channel', canonicalChannelNumberKey);
	conflicts.sort((left, right) =>
		left.severity.localeCompare(right.severity) || left.title.localeCompare(right.title));
	return {
		conflicts: conflicts.slice(0, MAX_STATUS_CONFLICTS),
		truncated: conflicts.length > MAX_STATUS_CONFLICTS,
	};
}
