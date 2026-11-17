import { createHash } from 'node:crypto';
import { BUILTIN_GUIDE_TEMPLATE, XMLTV_EPG_DAYS } from '@moirai/shared';
import type { MoiraiDatabase } from '../db/index.js';
import type { GuideReadRequest } from './read-job.js';

/** Increment when a guide presentation change makes previously published JSON obsolete. */
const SNAPSHOT_VERSION = 1;

/** Read only the durable inputs that identify a committed guide and its presentation. */
const revisionQueries = [
	'SELECT id, number, name, config FROM channels ORDER BY id',
	'SELECT * FROM channel_schedules ORDER BY channel_id',
	'SELECT * FROM channel_schedule_layers ORDER BY channel_id, position',
	'SELECT id, name, config FROM scheduling_programs ORDER BY id',
	'SELECT * FROM schedule_templates ORDER BY id',
	'SELECT * FROM schedule_slots ORDER BY template_id, position',
	'SELECT * FROM schedule_boundaries ORDER BY template_id, position',
	'SELECT id, is_default, sources FROM guide_templates ORDER BY id',
	`SELECT channel_id, revision, status, window_start, window_end, committed_at, pending_since, apply_after
		FROM timeline_materializations ORDER BY channel_id`,
	'SELECT id, last_scan_completed_at, last_indexed_change_at FROM libraries ORDER BY id',
];

/** Read the same revision at startup and inside the worker's guide read transaction. */
export function firstDayGuideKey(db: MoiraiDatabase, request: GuideReadRequest): string {
	const hash = createHash('sha256');
	hash.update(JSON.stringify([
		SNAPSHOT_VERSION, request.startDate, request.timeZone, request.publicUrl,
		request.guideDays ?? XMLTV_EPG_DAYS, BUILTIN_GUIDE_TEMPLATE.sources,
	]));
	for (const query of revisionQueries) {
		hash.update(JSON.stringify(db.$client.prepare(query).raw().all()));
	}
	return hash.digest('hex');
}
