import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createDatabase } from '../apps/server/src/db/index.js';
import { Repository } from '../apps/server/src/repository/index.js';
import { readCommittedScheduleGuide } from '../apps/server/src/guide/schedule-guide.js';
import { ftsMatchQuery } from '../apps/server/src/repository/catalog-search.js';

const SHOW_COUNT = 2_500;
const EPISODES_PER_SHOW = 24;
const CHANNEL_COUNT = 18;
const WINDOW_DAYS = 15;
const SEGMENTS_PER_DAY = 288;
const TIME_ZONE = 'UTC';

/** Format milliseconds for profile output. */
function ms(started: number): string {
	return `${(performance.now() - started).toFixed(1)}ms`;
}

/** Run a labeled step and print elapsed time. */
async function timed<T>(label: string, work: () => T | Promise<T>): Promise<T> {
	const started = performance.now();
	const value = await work();
	console.log(`${label.padEnd(52)} ${ms(started)}`);
	return value;
}

const database = createDatabase(':memory:', path.resolve('drizzle'));
const sqlite = database.sqlite;
const repository = new Repository(database.db);
const today = new Date().toISOString().slice(0, 10);
const windowStart = `${today}T00:00:00.000Z`;
const windowEnd = new Date(Date.parse(windowStart) + WINDOW_DAYS * 86_400_000).toISOString();
const libraryId = randomUUID();
const templateId = randomUUID();
const channelIds = Array.from({ length: CHANNEL_COUNT }, () => randomUUID());
const snapshot = JSON.stringify({
	id: 'media',
	kind: 'episode',
	title: 'Episode',
	plot: 'x'.repeat(800),
	playbackPath: '/media/episode.mkv',
	durationSeconds: 1800,
	availability: 'available',
});

sqlite.exec('PRAGMA synchronous = OFF');
sqlite.exec('BEGIN');
sqlite.prepare(`INSERT INTO libraries (id, name, type_key, source_type, source_config)
	VALUES (?, 'Shows', 'shows', 'on-disk', '{"scanRoot":"/media"}')`).run(libraryId);
sqlite.exec(`DROP TRIGGER IF EXISTS catalog_search_groups_ai;
	DROP TRIGGER IF EXISTS catalog_search_groups_au;
	DROP TRIGGER IF EXISTS catalog_search_groups_ad;
	DROP TRIGGER IF EXISTS catalog_search_items_ai;
	DROP TRIGGER IF EXISTS catalog_search_items_au;
	DROP TRIGGER IF EXISTS catalog_search_items_ad;
	DROP TRIGGER IF EXISTS catalog_search_people_ai;
	DROP TRIGGER IF EXISTS catalog_search_people_ad;
	DROP TRIGGER IF EXISTS catalog_search_genres_ai;
	DROP TRIGGER IF EXISTS catalog_search_genres_ad;`);

await timed(`seed ${SHOW_COUNT} shows`, () => {
	sqlite.prepare(`WITH RECURSIVE numbers(n) AS (
		SELECT 1 UNION ALL SELECT n+1 FROM numbers WHERE n < ?
	) INSERT INTO media_groups (id, library_id, parent_id, stable_key, kind, title, sort_title, metadata)
	SELECT 'show-'||n, ?, NULL, 'show-'||n, 'show',
		CASE WHEN n <= 8 THEN 'Seinfeld '||n ELSE 'Show '||n END,
		CASE WHEN n <= 8 THEN 'Seinfeld '||n ELSE 'Show '||n END,
		'{}' FROM numbers`).run(SHOW_COUNT, libraryId);
	sqlite.prepare(`WITH RECURSIVE numbers(n) AS (
		SELECT 1 UNION ALL SELECT n+1 FROM numbers WHERE n < ?
	) INSERT INTO media_groups (id, library_id, parent_id, stable_key, kind, title, sort_title, metadata)
	SELECT 'season-'||n, ?, 'show-'||n, 'season-'||n, 'season', 'Season 1', '00001', '{}'
	FROM numbers`).run(SHOW_COUNT, libraryId);
});

await timed(`seed ${SHOW_COUNT * EPISODES_PER_SHOW} episodes`, () => {
	sqlite.prepare(`WITH RECURSIVE shows(n) AS (
		SELECT 1 UNION ALL SELECT n+1 FROM shows WHERE n < ?
	), episodes(e) AS (
		SELECT 1 UNION ALL SELECT e+1 FROM episodes WHERE e < ?
	) INSERT INTO media_items (
		id, library_id, group_id, stable_key, kind, title, sort_title, relative_path, playback_path,
		plot, metadata_status, metadata, fingerprint, duration_milliseconds, date_added_at, title_bucket
	) SELECT 'ep-'||n||'-'||e, ?, 'season-'||n, 'ep-'||n||'-'||e, 'episode',
		CASE WHEN e = 12 THEN 'Christmas Special' ELSE 'Episode '||e END,
		CASE WHEN e = 12 THEN 'Christmas Special' ELSE 'Episode '||e END,
		'ep-'||n||'-'||e, '/media/ep-'||n||'-'||e,
		CASE WHEN e = 12 THEN 'A christmas episode' ELSE NULL END,
		'complete', '{}', 'fp', 1800000, ?, 'E'
	FROM shows, episodes`).run(
		SHOW_COUNT,
		EPISODES_PER_SHOW,
		libraryId,
		windowStart,
	);
});

await timed('rebuild catalog_search', () => {
	sqlite.exec('DELETE FROM catalog_search');
	sqlite.exec(`INSERT INTO catalog_search(library_id, entity_id, entity_kind, body)
		SELECT library_id, id, 'group', trim(title || ' ' || COALESCE(plot, '')) FROM media_groups`);
	sqlite.exec(`INSERT INTO catalog_search(library_id, entity_id, entity_kind, body)
		SELECT i.library_id, i.id, 'item', trim(
			i.title || ' ' || COALESCE(i.plot, '') || ' ' ||
			COALESCE((SELECT title FROM media_groups WHERE id = i.group_id), '') || ' ' ||
			COALESCE((SELECT parent.title FROM media_groups g JOIN media_groups parent ON parent.id = g.parent_id WHERE g.id = i.group_id), '')
		) FROM media_items i`);
});

sqlite.prepare('INSERT INTO schedule_templates (id, name, period) VALUES (?, \'Daily\', \'day\')').run(templateId);
for (let index = 0; index < CHANNEL_COUNT; index += 1) {
	const channelId = channelIds[index]!;
	sqlite.prepare('INSERT INTO channels (id, number, name, config) VALUES (?, ?, ?, \'{}\')')
		.run(channelId, String(index + 1), `Channel ${index + 1}`);
	sqlite.prepare(`INSERT INTO channel_schedules (channel_id, default_template_id, config)
		VALUES (?, ?, '{}')`).run(channelId, templateId);
	const occurrences = JSON.stringify(Array.from({ length: WINDOW_DAYS * 4 }, (_, occurrence) => ({
		id: `occ-${index}-${occurrence}`,
		templateId,
		slotId: 'slot',
		programId: null,
		scheduleLayerId: null,
		start: windowStart,
		finish: windowEnd,
	})));
	const issues = JSON.stringify(Array.from({ length: 40 }, (_, issue) => ({
		code: 'source-unavailable',
		message: `Issue ${issue} on channel ${index}`,
		occurrences: [{ start: windowStart, finish: windowEnd }],
	})));
	sqlite.prepare(`INSERT INTO timeline_materializations (
		channel_id, status, window_start, window_end, continuation_at, input_fingerprint,
		guide_occurrences, base_state, issues, committed_at
	) VALUES (?, 'ready', ?, ?, ?, 'fp', ?, '[]', ?, ?)`).run(
		channelId,
		windowStart,
		windowEnd,
		windowEnd,
		occurrences,
		issues,
		windowStart,
	);
}

await timed(`seed ${CHANNEL_COUNT * WINDOW_DAYS * SEGMENTS_PER_DAY} segments`, () => {
	const insert = sqlite.prepare(`INSERT INTO materialized_timeline_segments (
		id, channel_id, template_id, slot_id, program_ancestry, role, title, playback_path,
		playback_parts, starts_at, finishes_at, source_start_seconds, source_finish_seconds,
		truncated, media_snapshot, state_delta
	) VALUES (?, ?, ?, 'slot', '[]', 'primary', ?, '/media/ep.mkv', '[]', ?, ?, 0, 1800, 0, ?, '[]')`);
	const slotMs = 86_400_000 / SEGMENTS_PER_DAY;
	for (let channel = 0; channel < CHANNEL_COUNT; channel += 1) {
		for (let index = 0; index < WINDOW_DAYS * SEGMENTS_PER_DAY; index += 1) {
			const start = new Date(Date.parse(windowStart) + index * slotMs).toISOString();
			const finish = new Date(Date.parse(start) + slotMs).toISOString();
			insert.run(
				`seg-${channel}-${index}`,
				channelIds[channel]!,
				templateId,
				`Episode ${index}`,
				start,
				finish,
				snapshot,
			);
		}
	}
});
sqlite.exec('COMMIT');
sqlite.exec('PRAGMA synchronous = NORMAL');

const itemCount = sqlite.prepare('SELECT COUNT(*) AS count FROM media_items').get() as { count: number };
const groupCount = sqlite.prepare('SELECT COUNT(*) AS count FROM media_groups').get() as { count: number };
const segmentCount = sqlite.prepare('SELECT COUNT(*) AS count FROM materialized_timeline_segments').get() as { count: number };
console.log(`catalog: ${groupCount.count} groups, ${itemCount.count} items, ${segmentCount.count} segments`);

const browseQuery = {
	parentId: null,
	page: 1,
	pageSize: 100,
	sort: 'title' as const,
	direction: 'asc' as const,
	name: '',
	releaseYearFrom: null,
	releaseYearTo: null,
	minimumRating: null,
	minimumUserRating: null,
	addedFrom: null,
	addedBefore: null,
	genres: [] as string[],
	excludedGenres: [] as string[],
	genreMatch: 'any' as const,
	actor: '',
	director: '',
};

const sein = await timed('browseMedia search=Sein', () =>
	repository.browseMedia(libraryId, { ...browseQuery, search: 'Sein' }));
console.log(`  hits=${sein.pagination.totalEntries} page=${sein.items.length} first=${sein.items[0]?.title}`);

const christmas = await timed('browseMedia search=christmas', () =>
	repository.browseMedia(libraryId, { ...browseQuery, search: 'christmas' }));
console.log(`  hits=${christmas.pagination.totalEntries} page=${christmas.items.length}`);

const match = ftsMatchQuery('Sein');
if (match) {
	const plan = sqlite.prepare(
		'EXPLAIN QUERY PLAN SELECT entity_id FROM catalog_search WHERE catalog_search MATCH ? AND entity_kind = ? AND library_id = ?',
	).all(match, 'item', libraryId);
	console.log('  FTS plan', plan.map((row) => (row as { detail: string }).detail).join(' | '));
	await timed('raw FTS Sein ids', () => {
		sqlite.prepare(
			'SELECT entity_id FROM catalog_search WHERE catalog_search MATCH ? AND entity_kind = ? AND library_id = ? LIMIT 100',
		).all(match, 'item', libraryId);
	});
	await timed('COUNT flattened Sein', () => {
		sqlite.prepare(
			`SELECT COUNT(*) AS count FROM media_items i
			WHERE i.library_id = ? AND i.id IN (
				SELECT entity_id FROM catalog_search WHERE catalog_search MATCH ? AND entity_kind = 'item' AND library_id = ?
			)`,
		).get(libraryId, match, libraryId);
	});
}

const rangeEnd = new Date(Date.parse(windowStart) + 7 * 86_400_000).toISOString();
await timed('listOccupiedMediaIntervals 16 local days', () =>
	repository.listOccupiedMediaIntervals(windowStart, new Date(Date.parse(windowStart) + 16 * 86_400_000).toISOString()));
await timed('listMaterializedTimelineSegments one channel window', () =>
	repository.listMaterializedTimelineSegments(windowStart, windowEnd, channelIds[0]));
await timed('listTimelineMaterializationStatuses', () =>
	repository.listTimelineMaterializationStatuses());
await timed('listTimelineMaterializations', () =>
	repository.listTimelineMaterializations());
await timed('listMaterializedTimelineSegmentsForGuide 1 day', () =>
	repository.listMaterializedTimelineSegmentsForGuide(
		windowStart,
		new Date(Date.parse(windowStart) + 86_400_000).toISOString(),
		200_001,
		channelIds,
	));
const weekRows = await timed('listMaterializedTimelineSegmentsForGuide 7 day', () =>
	repository.listMaterializedTimelineSegmentsForGuide(
		windowStart,
		rangeEnd,
		200_001,
		channelIds,
	));
console.log(`  7-day rows=${weekRows.length}`);

const dayGuide = await timed('readCommittedScheduleGuide days=1', () =>
	readCommittedScheduleGuide(repository, TIME_ZONE, today, 1));
const weekGuide = await timed('readCommittedScheduleGuide days=7', () =>
	readCommittedScheduleGuide(repository, TIME_ZONE, today, 7));
await timed('readCommittedScheduleGuide days=7 cached', () =>
	readCommittedScheduleGuide(repository, TIME_ZONE, today, 7));
const dayJson = await timed('JSON.stringify 1-day guide', () => JSON.stringify(dayGuide.guide));
const weekJson = await timed('JSON.stringify 7-day guide', () => JSON.stringify(weekGuide.guide));
console.log(`  1-day channels=${dayGuide.guide.channels.length} json=${dayJson.length} bytes`);
console.log(`  7-day channels=${weekGuide.guide.channels.length} json=${weekJson.length} bytes`);
const weekSegments = weekGuide.guide.channels.reduce((sum, channel) => sum + channel.preview.segments.length, 0);
const weekEntries = weekGuide.guide.channels.reduce((sum, channel) => sum + (channel.entries?.length ?? 0), 0);
console.log(`  7-day segments=${weekSegments} entries=${weekEntries}`);

database.close();
