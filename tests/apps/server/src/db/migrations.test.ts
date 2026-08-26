import { readFile } from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

describe('database compatibility migrations', () => {
	it('removes obsolete full-server publication data while preserving playback settings', async () => {
		const sqlite = new Database(':memory:');
		sqlite.exec(`
      CREATE TABLE settings (
        key text PRIMARY KEY NOT NULL,
        value text NOT NULL,
        updated_at text NOT NULL
      );
      CREATE TABLE publish_runs (
        id text PRIMARY KEY NOT NULL,
        status text NOT NULL
      );
      INSERT INTO settings VALUES
        ('ersatztv', '{}', '2026-08-25T00:00:00Z'),
        ('playback', '{"maxActiveSessions":4}', '2026-08-25T00:00:00Z');
      INSERT INTO publish_runs VALUES ('run', 'succeeded');
    `);

		const migration = await readFile(
			path.resolve('drizzle/0013_integrated_playback.sql'),
			'utf8',
		);
		sqlite.transaction(() => {
			for (const statement of migration.split('--> statement-breakpoint')) {
				if (statement.trim()) {
					sqlite.exec(statement);
				}
			}
		})();

		expect(sqlite.prepare('SELECT key FROM settings').all()).toEqual([{ key: 'playback' }]);
		expect(
			sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'publish_runs'").get(),
		).toBeUndefined();
		sqlite.close();
	});

	it('invalidates NFO-derived durations and generated output for technical probe backfill', async () => {
		const sqlite = new Database(':memory:');
		sqlite.exec(`
      CREATE TABLE media_items (id text PRIMARY KEY NOT NULL, duration_seconds integer);
      CREATE TABLE materialized_timeline_segments (id text PRIMARY KEY NOT NULL);
      CREATE TABLE timeline_materializations (channel_id text PRIMARY KEY NOT NULL);
      INSERT INTO media_items VALUES ('item', 3600);
      INSERT INTO materialized_timeline_segments VALUES ('segment');
      INSERT INTO timeline_materializations VALUES ('channel');
    `);
		const migration = await readFile(path.resolve('drizzle/0011_media_probe.sql'), 'utf8');
		sqlite.transaction(() => {
			for (const statement of migration.split('--> statement-breakpoint')) {
				if (statement.trim()) {
					sqlite.exec(statement);
				}
			}
		})();

		expect(sqlite.prepare(
			'SELECT duration_seconds AS durationSeconds, duration_milliseconds AS durationMilliseconds, probe_status AS probeStatus FROM media_items',
		).get()).toEqual({ durationSeconds: null, durationMilliseconds: null, probeStatus: 'pending' });
		expect(sqlite.prepare('SELECT COUNT(*) AS count FROM materialized_timeline_segments').get())
			.toEqual({ count: 0 });
		expect(sqlite.prepare('SELECT COUNT(*) AS count FROM timeline_materializations').get())
			.toEqual({ count: 0 });
		sqlite.close();
	});

	it('adds channel ownership to the early selection-state table and preserves valid cursors', async () => {
		const sqlite = new Database(':memory:');
		sqlite.pragma('foreign_keys = ON');
		const channelId = '00000000-0000-4000-8000-000000000001';
		sqlite.exec('CREATE TABLE channels (id text PRIMARY KEY NOT NULL)');
		sqlite.exec(
			'CREATE TABLE selection_states (consumer_key text PRIMARY KEY NOT NULL, config_fingerprint text NOT NULL, value text NOT NULL, updated_at text NOT NULL)',
		);
		sqlite.prepare('INSERT INTO channels (id) VALUES (?)').run(channelId);
		sqlite
			.prepare(
				'INSERT INTO selection_states (consumer_key, config_fingerprint, value, updated_at) VALUES (?, ?, ?, ?)',
			)
			.run(
				`primary:${channelId}:template:slot:program`,
				'fingerprint',
				JSON.stringify({ type: 'sequential', nextIndex: 2, lastItemId: null }),
				'2026-08-19T00:00:00.000Z',
			);

		const migration = await readFile(
			path.resolve('drizzle/0003_selection_state_channel.sql'),
			'utf8',
		);
		sqlite.transaction(() => {
			for (const statement of migration.split('--> statement-breakpoint')) {
				if (statement.trim()) {
					sqlite.exec(statement);
				}
			}
		})();

		expect(sqlite.prepare('SELECT channel_id AS channelId FROM selection_states').get()).toEqual({
			channelId,
		});
		sqlite.prepare('DELETE FROM channels WHERE id = ?').run(channelId);
		expect(sqlite.prepare('SELECT COUNT(*) AS count FROM selection_states').get()).toEqual({
			count: 0,
		});
		sqlite.close();
	});

	it('makes slot programs optional without losing existing slots or boundaries', async () => {
		const sqlite = new Database(':memory:');
		sqlite.pragma('foreign_keys = ON');
		sqlite.exec(`
      CREATE TABLE scheduling_programs (id text PRIMARY KEY NOT NULL);
      CREATE TABLE schedule_templates (id text PRIMARY KEY NOT NULL);
      CREATE TABLE channel_schedules (channel_id text PRIMARY KEY NOT NULL);
      CREATE TABLE schedule_slots (
        id text PRIMARY KEY NOT NULL,
        template_id text NOT NULL REFERENCES schedule_templates(id) ON DELETE cascade,
        position integer NOT NULL,
        start_seconds integer NOT NULL,
        program_id text NOT NULL REFERENCES scheduling_programs(id) ON DELETE restrict,
        state_scope text NOT NULL,
        start_eligibility text NOT NULL,
        filler text NOT NULL
      );
      CREATE UNIQUE INDEX schedule_slots_template_position ON schedule_slots(template_id, position);
      CREATE UNIQUE INDEX schedule_slots_template_start ON schedule_slots(template_id, start_seconds);
      CREATE TABLE schedule_boundaries (
        id text PRIMARY KEY NOT NULL,
        template_id text NOT NULL REFERENCES schedule_templates(id) ON DELETE cascade,
        position integer NOT NULL,
        left_slot_id text NOT NULL REFERENCES schedule_slots(id) ON DELETE cascade,
        right_slot_id text NOT NULL REFERENCES schedule_slots(id) ON DELETE cascade,
        target_seconds integer NOT NULL,
        policy text NOT NULL,
        max_drift_seconds integer NOT NULL,
        fallback text NOT NULL
      );
      CREATE UNIQUE INDEX schedule_boundaries_template_position ON schedule_boundaries(template_id, position);
      CREATE UNIQUE INDEX schedule_boundaries_template_target ON schedule_boundaries(template_id, target_seconds);
      INSERT INTO scheduling_programs VALUES ('program');
      INSERT INTO schedule_templates VALUES ('template');
      INSERT INTO channel_schedules VALUES ('channel');
      INSERT INTO schedule_slots VALUES ('slot', 'template', 0, 0, 'program', 'persistent', '{}', '{}');
      INSERT INTO schedule_boundaries VALUES ('boundary', 'template', 0, 'slot', 'slot', 86400, 'hard', 0, 'reject-start');
    `);

		const migration = await readFile(path.resolve('drizzle/0005_layered_schedules.sql'), 'utf8');
		sqlite.transaction(() => {
			for (const statement of migration.split('--> statement-breakpoint')) {
				if (statement.trim()) {
					sqlite.exec(statement);
				}
			}
		})();

		expect(sqlite.prepare('SELECT id, program_id AS programId FROM schedule_slots').get()).toEqual({
			id: 'slot',
			programId: 'program',
		});
		expect(
			sqlite.prepare('SELECT id, left_slot_id AS leftSlotId FROM schedule_boundaries').get(),
		).toEqual({ id: 'boundary', leftSlotId: 'slot' });
		expect(() =>
			sqlite
				.prepare(
					"INSERT INTO schedule_slots VALUES ('fall-through', 'template', 1, 3600, NULL, 'persistent', '{}', '{}')",
				)
				.run()).not.toThrow();
		expect(() =>
			sqlite
				.prepare(
					"INSERT INTO channel_schedule_layers VALUES ('layer', 'channel', 0, 'template', '{}', '{}', '{}')",
				)
				.run()).not.toThrow();
		sqlite.close();
	});

	it('makes template boundary drift nullable without losing finite drift values', async () => {
		const sqlite = new Database(':memory:');
		sqlite.pragma('foreign_keys = ON');
		sqlite.exec(`
      CREATE TABLE schedule_templates (id text PRIMARY KEY NOT NULL);
      CREATE TABLE schedule_slots (
        id text PRIMARY KEY NOT NULL,
        template_id text NOT NULL REFERENCES schedule_templates(id) ON DELETE cascade
      );
      CREATE TABLE schedule_boundaries (
        id text PRIMARY KEY NOT NULL,
        template_id text NOT NULL REFERENCES schedule_templates(id) ON DELETE cascade,
        position integer NOT NULL,
        left_slot_id text NOT NULL REFERENCES schedule_slots(id) ON DELETE cascade,
        right_slot_id text NOT NULL REFERENCES schedule_slots(id) ON DELETE cascade,
        target_seconds integer NOT NULL,
        policy text NOT NULL,
        max_drift_seconds integer NOT NULL,
        fallback text NOT NULL
      );
      CREATE UNIQUE INDEX schedule_boundaries_template_position ON schedule_boundaries(template_id, position);
      CREATE UNIQUE INDEX schedule_boundaries_template_target ON schedule_boundaries(template_id, target_seconds);
      INSERT INTO schedule_templates VALUES ('template');
      INSERT INTO schedule_slots VALUES ('left', 'template'), ('right', 'template');
      INSERT INTO schedule_boundaries VALUES ('finite', 'template', 0, 'left', 'right', 3600, 'finish-left', 5400, 'reject-start');
    `);

		const migration = await readFile(
			path.resolve('drizzle/0006_unlimited_boundary_drift.sql'),
			'utf8',
		);
		sqlite.transaction(() => {
			for (const statement of migration.split('--> statement-breakpoint')) {
				if (statement.trim()) {
					sqlite.exec(statement);
				}
			}
		})();

		expect(
			sqlite
				.prepare('SELECT max_drift_seconds AS maxDriftSeconds FROM schedule_boundaries')
				.get(),
		).toEqual({ maxDriftSeconds: 5_400 });
		expect(() =>
			sqlite
				.prepare(
					"INSERT INTO schedule_boundaries VALUES ('unlimited', 'template', 1, 'left', 'right', 7200, 'finish-left', NULL, 'reject-start')",
				)
				.run()).not.toThrow();
		sqlite.close();
	});

	it('adds channel-owned durable timeline tables with cascading cleanup', async () => {
		const sqlite = new Database(':memory:');
		sqlite.pragma('foreign_keys = ON');
		sqlite.exec('CREATE TABLE channels (id text PRIMARY KEY NOT NULL)');
		sqlite.prepare("INSERT INTO channels VALUES ('channel')").run();
		const migration = await readFile(path.resolve('drizzle/0007_durable_timeline.sql'), 'utf8');
		sqlite.transaction(() => {
			for (const statement of migration.split('--> statement-breakpoint')) {
				if (statement.trim()) {
					sqlite.exec(statement);
				}
			}
		})();
		sqlite
			.prepare(
				"INSERT INTO timeline_materializations (channel_id, status, window_start, window_end, continuation_at, input_fingerprint, base_state, issues, committed_at) VALUES ('channel', 'ready', 'start', 'end', 'end', 'hash', '[]', '[]', 'now')",
			)
			.run();
		sqlite
			.prepare(
				"INSERT INTO materialized_timeline_segments VALUES ('segment', 'channel', NULL, 'template', 'slot', NULL, NULL, 'dead-air', 'Dead air', NULL, 'start', 'end', 0, NULL, 0, NULL, '[]')",
			)
			.run();

		sqlite.prepare("DELETE FROM channels WHERE id = 'channel'").run();

		expect(
			sqlite.prepare('SELECT COUNT(*) AS count FROM timeline_materializations').get(),
		).toEqual({ count: 0 });
		expect(
			sqlite.prepare('SELECT COUNT(*) AS count FROM materialized_timeline_segments').get(),
		).toEqual({ count: 0 });
		sqlite.close();
	});

	it('normalizes filler on existing no-program slots', async () => {
		const sqlite = new Database(':memory:');
		sqlite.exec(`
      CREATE TABLE schedule_slots (
        id text PRIMARY KEY NOT NULL,
        program_id text,
        filler text NOT NULL
      );
      INSERT INTO schedule_slots VALUES
        ('fall-through', NULL, '{"mode":"configured","config":{"programId":"old"}}'),
        ('programmed', 'program', '{"mode":"inherit"}');
    `);
		const migration = await readFile(path.resolve('drizzle/0010_no_program_filler.sql'), 'utf8');
		sqlite.exec(migration);
		expect(
			sqlite.prepare('SELECT filler FROM schedule_slots WHERE id = ?').get('fall-through'),
		).toEqual({ filler: '{"mode":"disabled"}' });
		expect(sqlite.prepare('SELECT filler FROM schedule_slots WHERE id = ?').get('programmed')).toEqual(
			{ filler: '{"mode":"inherit"}' },
		);
		sqlite.close();
	});

	it('adds typed video metadata, multipart aliases, and durable playback parts', async () => {
		const sqlite = new Database(':memory:');
		sqlite.pragma('foreign_keys = ON');
		sqlite.exec(`
      CREATE TABLE libraries (id text PRIMARY KEY NOT NULL);
      CREATE TABLE media_items (id text PRIMARY KEY NOT NULL);
      CREATE TABLE materialized_timeline_segments (id text PRIMARY KEY NOT NULL);
      INSERT INTO libraries VALUES ('library');
      INSERT INTO media_items VALUES ('item');
      INSERT INTO materialized_timeline_segments VALUES ('segment');
    `);
		const migration = await readFile(path.resolve('drizzle/0014_video_metadata.sql'), 'utf8');
		sqlite.transaction(() => {
			for (const statement of migration.split('--> statement-breakpoint')) {
				if (statement.trim()) {
					sqlite.exec(statement);
				}
			}
		})();

		expect(sqlite.prepare(
			'SELECT external_ids AS externalIds, artists, multipart_status AS multipartStatus, parts, subtitle_tracks AS subtitleTracks FROM media_items',
		).get()).toEqual({
			externalIds: '[]',
			artists: '[]',
			multipartStatus: 'none',
			parts: '[]',
			subtitleTracks: '[]',
		});
		expect(sqlite.prepare(
			'SELECT playback_parts AS playbackParts FROM materialized_timeline_segments',
		).get()).toEqual({ playbackParts: '[]' });
		sqlite.prepare(
			"INSERT INTO media_item_aliases (alias_id, library_id, item_id) VALUES ('old-part', 'library', 'item')",
		).run();
		sqlite.prepare("DELETE FROM media_items WHERE id = 'item'").run();
		expect(sqlite.prepare('SELECT COUNT(*) AS count FROM media_item_aliases').get()).toEqual({
			count: 0,
		});
		sqlite.close();
	});

	it('generalizes persisted source identities without changing their stable source key', async () => {
		const sqlite = new Database(':memory:');
		sqlite.exec(`
      CREATE TABLE libraries (
        id text PRIMARY KEY NOT NULL,
        accepted_source_identity text,
        candidate_source_identity text
      );
      INSERT INTO libraries VALUES (
        'library',
        '{"sourceType":"on-disk","canonicalRoot":"/media","device":"1","inode":"2"}',
        '{"sourceType":"on-disk","canonicalRoot":"/replacement","device":"3","inode":"4"}'
      );
    `);
		const migration = await readFile(path.resolve('drizzle/0015_source_adapters.sql'), 'utf8');
		for (const statement of migration.split('--> statement-breakpoint')) {
			if (statement.trim()) {
				sqlite.exec(statement);
			}
		}

		const row = sqlite.prepare(
			'SELECT accepted_source_identity AS accepted, candidate_source_identity AS candidate FROM libraries',
		).get() as { accepted: string; candidate: string };
		expect(JSON.parse(row.accepted)).toEqual({
			sourceType: 'on-disk',
			sourceKey: '/media',
			details: { canonicalRoot: '/media', device: '1', inode: '2' },
		});
		expect(JSON.parse(row.candidate)).toEqual({
			sourceType: 'on-disk',
			sourceKey: '/replacement',
			details: { canonicalRoot: '/replacement', device: '3', inode: '4' },
		});
		sqlite.close();
	});
});
