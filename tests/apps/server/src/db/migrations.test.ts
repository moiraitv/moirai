import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { createDatabase } from '@server/db/index.js';

interface MigrationJournalEntry {
	idx: number;
	version: string;
	when: number;
	tag: string;
	breakpoints: boolean;
}

interface MigrationJournal {
	version: string;
	dialect: string;
	entries: MigrationJournalEntry[];
}

type SqliteDatabase = InstanceType<typeof Database>;
type DatabaseStep = (sqlite: SqliteDatabase) => void;

const migrationsDir = path.resolve('drizzle');

async function migrationJournal(): Promise<MigrationJournal> {
	return JSON.parse(
		await readFile(path.join(migrationsDir, 'meta/_journal.json'), 'utf8'),
	) as MigrationJournal;
}

async function createMigrationPrefix(
	root: string,
	journal: MigrationJournal,
	priorTag: string,
): Promise<{ dir: string; prior: MigrationJournalEntry }> {
	const priorIndex = journal.entries.findIndex((entry) => entry.tag === priorTag);
	if (priorIndex < 0) {
		throw new Error(`Unknown prior migration ${priorTag}`);
	}

	const entries = journal.entries.slice(0, priorIndex + 1);
	const dir = path.join(root, 'migrations');
	await mkdir(path.join(dir, 'meta'), { recursive: true });
	await writeFile(
		path.join(dir, 'meta/_journal.json'),
		`${JSON.stringify({ ...journal, entries }, null, 2)}\n`,
	);
	await Promise.all(entries.map((entry) =>
		copyFile(path.join(migrationsDir, `${entry.tag}.sql`), path.join(dir, `${entry.tag}.sql`))));

	return { dir, prior: entries.at(-1)! };
}

function migrationMarkers(sqlite: SqliteDatabase): number[] {
	return sqlite.prepare(
		'SELECT created_at AS createdAt FROM __drizzle_migrations ORDER BY created_at',
	).all().map((row) => Number((row as { createdAt: number }).createdAt));
}

async function upgradeFrom(
	priorTag: string,
	seed: DatabaseStep,
	verify: DatabaseStep,
): Promise<void> {
	const root = await mkdtemp(path.join(os.tmpdir(), 'moirai-migration-'));
	const databasePath = path.join(root, 'data', 'moirai.sqlite');
	let priorDatabase: ReturnType<typeof createDatabase> | undefined;
	let currentDatabase: ReturnType<typeof createDatabase> | undefined;

	try {
		const journal = await migrationJournal();
		const prefix = await createMigrationPrefix(root, journal, priorTag);
		priorDatabase = createDatabase(databasePath, prefix.dir);
		expect(migrationMarkers(priorDatabase.sqlite)).toEqual(
			journal.entries.slice(0, prefix.prior.idx + 1).map((entry) => entry.when),
		);
		seed(priorDatabase.sqlite);
		priorDatabase.close();
		priorDatabase = undefined;

		currentDatabase = createDatabase(databasePath, migrationsDir);
		expect(migrationMarkers(currentDatabase.sqlite)).toEqual(
			journal.entries.map((entry) => entry.when),
		);
		verify(currentDatabase.sqlite);
	}
	finally {
		priorDatabase?.close();
		currentDatabase?.close();
		await rm(root, { recursive: true, force: true });
	}
}

function insertLibrary(sqlite: SqliteDatabase, id = 'library', name = 'Library'): void {
	sqlite.prepare(
		`INSERT INTO libraries (id, name, type_key, source_type, source_config)
			VALUES (?, ?, 'movies', 'on-disk', '{}')`,
	).run(id, name);
}

function insertChannel(sqlite: SqliteDatabase, id = 'channel', number = '1'): void {
	sqlite.prepare(
		'INSERT INTO channels (id, number, name, config) VALUES (?, ?, ?, ?)',
	).run(id, number, `Channel ${number}`, '{}');
}

function insertMediaItem(
	sqlite: SqliteDatabase,
	id = 'item',
	libraryId = 'library',
): void {
	sqlite.prepare(
		`INSERT INTO media_items (
			id, library_id, stable_key, kind, title, sort_title, relative_path, playback_path,
			metadata_status, metadata, fingerprint
		) VALUES (?, ?, ?, 'movie', 'Movie', 'movie', ?, ?, 'complete', '{}', 'fingerprint')`,
	).run(id, libraryId, id, `${id}.mkv`, `/media/${id}.mkv`);
}

function insertScheduleFoundation(sqlite: SqliteDatabase): void {
	insertChannel(sqlite);
	sqlite.prepare(
		"INSERT INTO scheduling_programs (id, name, config) VALUES ('program', 'Program', '{}')",
	).run();
	sqlite.prepare(
		"INSERT INTO schedule_templates (id, name) VALUES ('template', 'Template')",
	).run();
}

describe('database compatibility migrations', () => {
	it('upgrades each recent migration boundary through the production installer', async () => {
		const boundaries = [
			['0010_no_program_filler', '0011_media_probe'],
			['0011_media_probe', '0012_data_identity'],
			['0012_data_identity', '0013_integrated_playback'],
			['0013_integrated_playback', '0014_video_metadata'],
			['0014_video_metadata', '0015_source_adapters'],
			['0015_source_adapters', '0016_authentication'],
			['0016_authentication', '0017_boundary_early_start'],
			['0017_boundary_early_start', '0018_timeline_continuation'],
		] as const;

		for (const [priorTag, targetTag] of boundaries) {
			await upgradeFrom(
				priorTag,
				(sqlite) => {
					sqlite.prepare('INSERT INTO settings (key, value) VALUES (?, ?)')
						.run(`upgrade:${targetTag}`, JSON.stringify({ targetTag }));
				},
				(sqlite) => {
					const value = sqlite.prepare('SELECT value FROM settings WHERE key = ?')
						.get(`upgrade:${targetTag}`) as { value: string };
					expect(JSON.parse(value.value)).toEqual({ targetTag });
				},
			);
		}
	});

	it('upgrades pre-integrated playback data while preserving playback settings', async () => {
		await upgradeFrom(
			'0012_data_identity',
			(sqlite) => {
				sqlite.prepare("INSERT INTO settings (key, value) VALUES ('ersatztv', '{}')").run();
				sqlite.prepare(
					"INSERT INTO settings (key, value) VALUES ('playback', '{\"maxActiveSessions\":4}')",
				).run();
				sqlite.exec('CREATE TABLE publish_runs (id text PRIMARY KEY NOT NULL, status text NOT NULL)');
				sqlite.prepare("INSERT INTO publish_runs VALUES ('run', 'succeeded')").run();
			},
			(sqlite) => {
				expect(sqlite.prepare('SELECT key FROM settings ORDER BY key').all())
					.toEqual([{ key: 'playback' }]);
				expect(sqlite.prepare(
					"SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'publish_runs'",
				).get()).toBeUndefined();
			},
		);
	});

	it('adds nullable continuation checkpoints without changing committed segment state', async () => {
		await upgradeFrom('0017_boundary_early_start', (sqlite) => {
			insertChannel(sqlite);
			sqlite.prepare(`INSERT INTO materialized_timeline_segments (
				id, channel_id, template_id, slot_id, role, title, starts_at, finishes_at,
				source_start_seconds, truncated, state_delta
			) VALUES ('segment', 'channel', 'template', 'slot', 'primary', 'Movie',
				'2026-09-02T23:40:00Z', '2026-09-03T00:20:00Z', 0, 0, '[{"consumerKey":"saved"}]')`).run();
		}, (sqlite) => {
			expect(sqlite.prepare('SELECT continuation, state_delta, starts_at, finishes_at FROM materialized_timeline_segments').get())
				.toEqual({ continuation: null, state_delta: '[{"consumerKey":"saved"}]', starts_at: '2026-09-02T23:40:00Z', finishes_at: '2026-09-03T00:20:00Z' });
		});
	});

	it('upgrades pre-probe media and invalidates generated output that used NFO durations', async () => {
		await upgradeFrom(
			'0010_no_program_filler',
			(sqlite) => {
				insertLibrary(sqlite);
				insertMediaItem(sqlite);
				insertChannel(sqlite);
				sqlite.prepare('UPDATE media_items SET duration_seconds = 3600 WHERE id = ?').run('item');
				sqlite.prepare(
					`INSERT INTO timeline_materializations (
						channel_id, status, window_start, window_end, continuation_at, input_fingerprint,
						base_state, issues, committed_at
					) VALUES ('channel', 'ready', 'start', 'end', 'end', 'hash', '[]', '[]', 'now')`,
				).run();
				sqlite.prepare(
					`INSERT INTO materialized_timeline_segments (
						id, channel_id, template_id, slot_id, role, title, starts_at, finishes_at,
						source_start_seconds, truncated, state_delta
					) VALUES ('segment', 'channel', 'template', 'slot', 'primary', 'Movie',
						'start', 'end', 0, 0, '[]')`,
				).run();
			},
			(sqlite) => {
				expect(sqlite.prepare(
					`SELECT duration_seconds AS durationSeconds,
						duration_milliseconds AS durationMilliseconds, probe_status AS probeStatus
					FROM media_items`,
				).get()).toEqual({
					durationSeconds: null,
					durationMilliseconds: null,
					probeStatus: 'pending',
				});
				expect(sqlite.prepare('SELECT COUNT(*) AS count FROM materialized_timeline_segments').get())
					.toEqual({ count: 0 });
				expect(sqlite.prepare('SELECT COUNT(*) AS count FROM timeline_materializations').get())
					.toEqual({ count: 0 });
			},
		);
	});

	it('upgrades early selection state while preserving valid channel-owned cursors', async () => {
		const channelId = '00000000-0000-4000-8000-000000000001';
		await upgradeFrom(
			'0002_scheduling_foundation',
			(sqlite) => {
				insertChannel(sqlite, channelId);
				sqlite.exec(`
					DROP TABLE selection_states;
					CREATE TABLE selection_states (
						consumer_key text PRIMARY KEY NOT NULL,
						config_fingerprint text NOT NULL,
						value text NOT NULL,
						updated_at text DEFAULT CURRENT_TIMESTAMP NOT NULL
					);
				`);
				sqlite.prepare(
					`INSERT INTO selection_states (consumer_key, config_fingerprint, value)
						VALUES (?, 'fingerprint', ?)`,
				).run(
					`primary:${channelId}:template:slot:program`,
					JSON.stringify({ type: 'sequential', nextIndex: 2, lastItemId: null }),
				);
			},
			(sqlite) => {
				expect(sqlite.prepare(
					'SELECT channel_id AS channelId, value FROM selection_states',
				).get()).toEqual({
					channelId,
					value: JSON.stringify({ type: 'sequential', nextIndex: 2, lastItemId: null }),
				});
				sqlite.prepare('DELETE FROM channels WHERE id = ?').run(channelId);
				expect(sqlite.prepare('SELECT COUNT(*) AS count FROM selection_states').get())
					.toEqual({ count: 0 });
			},
		);
	});

	it('upgrades fixed program slots to optional slots without losing boundaries', async () => {
		await upgradeFrom(
			'0004_media_availability',
			(sqlite) => {
				insertScheduleFoundation(sqlite);
				sqlite.prepare(
					`INSERT INTO channel_schedules (channel_id, default_template_id, config)
						VALUES ('channel', 'template', '{}')`,
				).run();
				sqlite.prepare(
					`INSERT INTO schedule_slots (
						id, template_id, position, start_seconds, program_id, state_scope,
						start_eligibility, filler
					) VALUES ('slot', 'template', 0, 0, 'program', 'persistent', '{}', '{}')`,
				).run();
				sqlite.prepare(
					`INSERT INTO schedule_boundaries (
						id, template_id, position, left_slot_id, right_slot_id, target_seconds,
						policy, max_drift_seconds, fallback
					) VALUES ('boundary', 'template', 0, 'slot', 'slot', 86400,
						'hard', 0, 'reject-start')`,
				).run();
			},
			(sqlite) => {
				expect(sqlite.prepare('SELECT id, program_id AS programId FROM schedule_slots').get())
					.toEqual({ id: 'slot', programId: 'program' });
				expect(sqlite.prepare(
					'SELECT id, left_slot_id AS leftSlotId FROM schedule_boundaries',
				).get()).toEqual({ id: 'boundary', leftSlotId: 'slot' });
				expect(() => sqlite.prepare(
					`INSERT INTO schedule_slots (
						id, template_id, position, start_seconds, program_id, state_scope,
						start_eligibility, filler
					) VALUES ('fall-through', 'template', 1, 3600, NULL, 'persistent', '{}', '{}')`,
				).run()).not.toThrow();
				expect(() => sqlite.prepare(
					`INSERT INTO channel_schedule_layers (
						id, channel_id, position, template_id, predicate, entry_boundary, exit_boundary
					) VALUES ('layer', 'channel', 0, 'template', '{}', '{}', '{}')`,
				).run()).not.toThrow();
			},
		);
	});

	it('upgrades boundary drift to nullable while preserving finite limits', async () => {
		await upgradeFrom(
			'0005_layered_schedules',
			(sqlite) => {
				insertScheduleFoundation(sqlite);
				for (const [id, position, start] of [['left', 0, 0], ['right', 1, 3600]] as const) {
					sqlite.prepare(
						`INSERT INTO schedule_slots (
							id, template_id, position, start_seconds, program_id, state_scope,
							start_eligibility, filler
						) VALUES (?, 'template', ?, ?, 'program', 'persistent', '{}', '{}')`,
					).run(id, position, start);
				}
				sqlite.prepare(
					`INSERT INTO schedule_boundaries (
						id, template_id, position, left_slot_id, right_slot_id, target_seconds,
						policy, max_drift_seconds, fallback
					) VALUES ('finite', 'template', 0, 'left', 'right', 3600,
						'finish-left', 5400, 'reject-start')`,
				).run();
			},
			(sqlite) => {
				expect(sqlite.prepare(
					'SELECT max_drift_seconds AS maxDriftSeconds FROM schedule_boundaries',
				).get()).toEqual({ maxDriftSeconds: 5_400 });
				expect(() => sqlite.prepare(
					`INSERT INTO schedule_boundaries (
						id, template_id, position, left_slot_id, right_slot_id, target_seconds,
						policy, max_drift_seconds, fallback
					) VALUES ('unlimited', 'template', 1, 'left', 'right', 7200,
						'finish-left', NULL, 'reject-start')`,
				).run()).not.toThrow();
			},
		);
	});

	it('adds zero early-start drift without changing existing boundary behavior', async () => {
		await upgradeFrom(
			'0016_authentication',
			(sqlite) => {
				insertScheduleFoundation(sqlite);
				for (const [id, position, start] of [['left', 0, 0], ['right', 1, 3_600]] as const) {
					sqlite.prepare(
						`INSERT INTO schedule_slots (
							id, template_id, position, start_seconds, program_id, state_scope,
							start_eligibility, filler
						) VALUES (?, 'template', ?, ?, 'program', 'persistent', '{}', '{}')`,
					).run(id, position, start);
				}
				sqlite.prepare(
					`INSERT INTO schedule_boundaries (
						id, template_id, position, left_slot_id, right_slot_id, target_seconds,
						policy, max_drift_seconds, fallback
					) VALUES ('boundary', 'template', 0, 'left', 'right', 3600,
						'finish-left', 5400, 'reject-start')`,
				).run();
			},
			(sqlite) => {
				expect(sqlite.prepare(
					`SELECT policy, max_drift_seconds AS maxDriftSeconds, fallback,
						early_start_max_drift_seconds AS earlyStartMaxDriftSeconds
					FROM schedule_boundaries WHERE id = 'boundary'`,
				).get()).toEqual({
					policy: 'finish-left',
					maxDriftSeconds: 5_400,
					fallback: 'reject-start',
					earlyStartMaxDriftSeconds: 0,
				});
			},
		);
	});

	it('upgrades to durable timelines with channel-owned cascading cleanup', async () => {
		await upgradeFrom(
			'0006_unlimited_boundary_drift',
			(sqlite) => insertChannel(sqlite),
			(sqlite) => {
				sqlite.prepare(
					`INSERT INTO timeline_materializations (
						channel_id, status, window_start, window_end, continuation_at, input_fingerprint,
						base_state, issues, committed_at
					) VALUES ('channel', 'ready', 'start', 'end', 'end', 'hash', '[]', '[]', 'now')`,
				).run();
				sqlite.prepare(
					`INSERT INTO materialized_timeline_segments (
						id, channel_id, template_id, slot_id, role, title, starts_at, finishes_at,
						source_start_seconds, truncated, state_delta
					) VALUES ('segment', 'channel', 'template', 'slot', 'dead-air', 'Dead air',
						'start', 'end', 0, 0, '[]')`,
				).run();
				sqlite.prepare("DELETE FROM channels WHERE id = 'channel'").run();
				expect(sqlite.prepare('SELECT COUNT(*) AS count FROM timeline_materializations').get())
					.toEqual({ count: 0 });
				expect(sqlite.prepare('SELECT COUNT(*) AS count FROM materialized_timeline_segments').get())
					.toEqual({ count: 0 });
			},
		);
	});

	it('upgrades no-program slots by disabling incompatible configured filler', async () => {
		await upgradeFrom(
			'0009_channel_tvg_index',
			(sqlite) => {
				insertScheduleFoundation(sqlite);
				sqlite.prepare(
					`INSERT INTO schedule_slots (
						id, template_id, position, start_seconds, program_id, state_scope,
						start_eligibility, filler
					) VALUES ('fall-through', 'template', 0, 0, NULL, 'persistent', '{}',
						'{"mode":"configured","config":{"programId":"old"}}')`,
				).run();
				sqlite.prepare(
					`INSERT INTO schedule_slots (
						id, template_id, position, start_seconds, program_id, state_scope,
						start_eligibility, filler
					) VALUES ('programmed', 'template', 1, 3600, 'program', 'persistent', '{}',
						'{"mode":"inherit"}')`,
				).run();
			},
			(sqlite) => {
				expect(sqlite.prepare('SELECT filler FROM schedule_slots WHERE id = ?')
					.get('fall-through')).toEqual({ filler: '{"mode":"disabled"}' });
				expect(sqlite.prepare('SELECT filler FROM schedule_slots WHERE id = ?')
					.get('programmed')).toEqual({ filler: '{"mode":"inherit"}' });
			},
		);
	});

	it('upgrades data identity fields without changing existing resource values', async () => {
		await upgradeFrom(
			'0011_media_probe',
			(sqlite) => {
				insertLibrary(sqlite);
				insertChannel(sqlite);
				sqlite.prepare(
					`INSERT INTO media_groups (
						id, library_id, stable_key, kind, title, sort_title, metadata
					) VALUES ('group', 'library', 'group', 'show', 'Show', 'show', '{}')`,
				).run();
				sqlite.prepare(
					"INSERT INTO scheduling_programs (id, name, config) VALUES ('program', 'Program', '{}')",
				).run();
				sqlite.prepare(
					"INSERT INTO schedule_templates (id, name) VALUES ('template', 'Template')",
				).run();
			},
			(sqlite) => {
				expect(sqlite.prepare(
					`SELECT l.name, l.name_key AS nameKey, g.title, g.source_key AS sourceKey,
						c.number_key AS numberKey, p.name_key AS programNameKey,
						t.name_key AS templateNameKey
					FROM libraries l, media_groups g, channels c, scheduling_programs p,
						schedule_templates t
					WHERE l.id = 'library' AND g.id = 'group' AND c.id = 'channel'
						AND p.id = 'program' AND t.id = 'template'`,
				).get()).toEqual({
					name: 'Library',
					nameKey: null,
					title: 'Show',
					sourceKey: null,
					numberKey: null,
					programNameKey: null,
					templateNameKey: null,
				});
				sqlite.prepare("UPDATE libraries SET name_key = 'library' WHERE id = 'library'").run();
				expect(() => {
					insertLibrary(sqlite, 'duplicate', 'Duplicate');
					sqlite.prepare("UPDATE libraries SET name_key = 'library' WHERE id = 'duplicate'").run();
				}).toThrow();
			},
		);
	});

	it('upgrades typed video metadata, aliases, and playback-part defaults', async () => {
		await upgradeFrom(
			'0013_integrated_playback',
			(sqlite) => {
				insertLibrary(sqlite);
				insertMediaItem(sqlite);
				insertChannel(sqlite);
				sqlite.prepare(
					`INSERT INTO materialized_timeline_segments (
						id, channel_id, template_id, slot_id, role, title, starts_at, finishes_at,
						source_start_seconds, truncated, state_delta
					) VALUES ('segment', 'channel', 'template', 'slot', 'primary', 'Movie',
						'start', 'end', 0, 0, '[]')`,
				).run();
			},
			(sqlite) => {
				expect(sqlite.prepare(
					`SELECT external_ids AS externalIds, artists, multipart_status AS multipartStatus,
						parts, subtitle_tracks AS subtitleTracks FROM media_items`,
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
					`INSERT INTO media_item_aliases (alias_id, library_id, item_id)
						VALUES ('old-part', 'library', 'item')`,
				).run();
				sqlite.prepare("DELETE FROM media_items WHERE id = 'item'").run();
				expect(sqlite.prepare('SELECT COUNT(*) AS count FROM media_item_aliases').get())
					.toEqual({ count: 0 });
			},
		);
	});

	it('upgrades persisted source identities without changing their stable source keys', async () => {
		await upgradeFrom(
			'0014_video_metadata',
			(sqlite) => {
				insertLibrary(sqlite);
				sqlite.prepare(
					`UPDATE libraries SET accepted_source_identity = ?, candidate_source_identity = ?
						WHERE id = 'library'`,
				).run(
					JSON.stringify({ sourceType: 'on-disk', canonicalRoot: '/media', device: '1', inode: '2' }),
					JSON.stringify({ sourceType: 'on-disk', canonicalRoot: '/replacement', device: '3', inode: '4' }),
				);
			},
			(sqlite) => {
				const row = sqlite.prepare(
					`SELECT accepted_source_identity AS accepted,
						candidate_source_identity AS candidate FROM libraries`,
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
			},
		);
	});

	it('upgrades to the bounded local and OIDC authentication capabilities', async () => {
		await upgradeFrom(
			'0015_source_adapters',
			(sqlite) => {
				sqlite.prepare(
					"INSERT INTO settings (key, value) VALUES ('authentication:fixture', '{\"enabled\":true}')",
				).run();
			},
			(sqlite) => {
				expect(sqlite.prepare(
					"SELECT value FROM settings WHERE key = 'authentication:fixture'",
				).get()).toEqual({ value: '{"enabled":true}' });
				sqlite.prepare(
					`INSERT INTO authentication_identities (
						id, provider, display_name, username, username_key, password_hash
					) VALUES ('local', 'local', 'Admin', 'Admin', 'admin', 'hash')`,
				).run();
				expect(() => sqlite.prepare(
					`INSERT INTO authentication_identities (
						id, provider, display_name, username, username_key, password_hash
					) VALUES ('other', 'local', 'Other', 'Other', 'other', 'hash')`,
				).run()).toThrow();
				sqlite.prepare(
					`INSERT INTO authentication_sessions (
						token_hash, identity_id, csrf_token, created_at, last_seen_at, expires_at
					) VALUES ('token', 'local', 'csrf', 'now', 'now', 'later')`,
				).run();
				sqlite.prepare(
					`INSERT INTO authentication_oidc_transactions (
						state_hash, binding_hash, code_verifier, nonce, return_to,
						logout_generation, expires_at
					) VALUES ('state', 'binding', 'verifier', 'nonce', '/', 3, 'later')`,
				).run();
				sqlite.prepare(
					'INSERT INTO authentication_oidc_logout_generation (id, generation) VALUES (1, 3)',
				).run();
				expect(() => sqlite.prepare(
					'INSERT INTO authentication_oidc_logout_generation (id, generation) VALUES (2, 4)',
				).run()).toThrow();
				sqlite.prepare(
					"INSERT INTO authentication_oidc_logout_tokens (token_hash, expires_at) VALUES ('hash', 'later')",
				).run();
				expect(sqlite.prepare(
					`SELECT binding_hash AS bindingHash, logout_generation AS logoutGeneration
						FROM authentication_oidc_transactions`,
				).get()).toEqual({ bindingHash: 'binding', logoutGeneration: 3 });
				expect(sqlite.prepare(
					`SELECT provider_configuration_hash AS providerConfigurationHash
						FROM authentication_sessions`,
				).get()).toEqual({ providerConfigurationHash: null });
				sqlite.prepare("DELETE FROM authentication_identities WHERE id = 'local'").run();
				expect(sqlite.prepare('SELECT COUNT(*) AS count FROM authentication_sessions').get())
					.toEqual({ count: 0 });
			},
		);
	});
});

it('upgrades subtitle settings without changing existing normalization or authored values', async () => {
	await upgradeFrom('0018_timeline_continuation', (sqlite) => {
		sqlite.prepare('INSERT INTO channels (id, number, number_key, name, config, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('subtitle-channel', '98', '98', 'Music', JSON.stringify({ number: '98', name: 'Music', subtitleMode: 'convert', customValue: 'preserved' }), '2026-09-01', '2026-09-01');
	}, (sqlite) => {
		const row = sqlite.prepare("SELECT config FROM channels WHERE id = 'subtitle-channel'").get() as { config: string };
		expect(JSON.parse(row.config)).toMatchObject({ subtitleMode: 'convert', customValue: 'preserved', subtitlePreferences: {}, subtitleFontsFolder: null });
		expect(sqlite.prepare('SELECT * FROM credit_templates WHERE is_builtin = 0').all()).toEqual([]);
		expect(sqlite.prepare('PRAGMA table_info(materialized_timeline_segments)').all()).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'program_ancestry', dflt_value: "'[]'" })]));
	});
});

it('upgrades existing channels to Custom while preserving every authored setting', async () => {
	const prior = { number: '98', name: 'Existing', video: { width: 640, height: 480, accel: null }, audio: { bitrateKbps: 128 }, subtitleMode: 'convert', subtitlePreferences: { language: 'eng', policy: 'forced' }, subtitleFontsFolder: '/fonts', ffmpegPath: '/custom/ffmpeg' };
	await upgradeFrom('0019_subtitles', (sqlite) => {
		sqlite.prepare('INSERT INTO channels (id, number, number_key, name, config, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('existing-channel', '98', '98', 'Existing', JSON.stringify(prior), '2026-09-01', '2026-09-01');
	}, (sqlite) => {
		const row = sqlite.prepare("SELECT config FROM channels WHERE id = 'existing-channel'").get() as { config: string };
		expect(JSON.parse(row.config)).toEqual({ ...prior, encodingProfileId: null });
		expect(sqlite.prepare('SELECT * FROM encoding_profiles WHERE is_builtin = 0').all()).toEqual([]);
	});
});

it('seeds presets during upgrade without replacing custom profiles or channel settings', async () => {
	const { BUILTIN_ENCODING_PROFILES, DEFAULT_ENCODING_PROFILE_ID } = await import('@moirai/shared');
	const custom = { name: '1080p', audio: { bitrateKbps: 123 }, video: { width: 987 } };
	await upgradeFrom('0020_encoding_profiles', (sqlite) => {
		sqlite.prepare('INSERT INTO encoding_profiles (id,name,name_key,config,created_at,updated_at) VALUES (?,?,?,?,?,?)').run('custom', custom.name, '1080p', JSON.stringify(custom), 'before', 'before');
		sqlite.prepare('INSERT INTO channels (id,number,number_key,name,config,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').run('channel', '1', '1', 'Existing', JSON.stringify({ encodingProfileId: 'custom', ...custom }), 'before', 'before');
	}, (sqlite) => {
		const rows = sqlite.prepare('SELECT id,config,is_builtin AS isBuiltin,is_default AS isDefault FROM encoding_profiles').all() as Array<{ id: string; config: string; isBuiltin: number; isDefault: number }>;
		expect(JSON.parse(rows.find((row) => row.id === 'custom')!.config)).toEqual({ ...custom, description: '' });
		expect(rows.filter((row) => row.isDefault).map((row) => row.id)).toEqual([DEFAULT_ENCODING_PROFILE_ID]);
		for (const expected of BUILTIN_ENCODING_PROFILES) {
			const row = rows.find((row) => row.id === expected.id)!;
			expect(row.isBuiltin).toBe(1);
			expect(JSON.parse(row.config)).toMatchObject({ description: expected.description, audio: expected.audio, video: expected.video });
		}
		const channel = sqlite.prepare("SELECT config FROM channels WHERE id='channel'").get() as { config: string };
		expect(JSON.parse(channel.config)).toEqual({ encodingProfileId: 'custom', ...custom });
	});
});

it('adds descriptions to existing presets while preserving authored metadata and defaults', async () => {
	const { BUILTIN_ENCODING_PROFILES } = await import('@moirai/shared');
	const custom = { name: 'Music videos', description: 'Living room', audio: { bitrateKbps: 123 }, video: { width: 987 } };
	await upgradeFrom('0021_encoding_presets', (sqlite) => {
		sqlite.prepare('UPDATE encoding_profiles SET is_default = 0').run();
		sqlite.prepare('INSERT INTO encoding_profiles (id,name,name_key,config,is_default,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').run('custom', custom.name, 'music videos', JSON.stringify(custom), 1, 'before', 'before');
	}, (sqlite) => {
		const rows = sqlite.prepare('SELECT id,config,is_default AS isDefault FROM encoding_profiles').all() as Array<{ id: string; config: string; isDefault: number }>;
		expect(JSON.parse(rows.find((row) => row.id === 'custom')!.config)).toEqual(custom);
		expect(rows.filter((row) => row.isDefault).map((row) => row.id)).toEqual(['custom']);
		for (const expected of BUILTIN_ENCODING_PROFILES) {
			expect(JSON.parse(rows.find((row) => row.id === expected.id)!.config)).toMatchObject({ description: expected.description, audio: expected.audio, video: expected.video });
		}
	});
});

it('installs the built-in credit design without replacing an existing same-name template', async () => {
	const { BUILTIN_CREDIT_TEMPLATE } = await import('@moirai/shared');
	await upgradeFrom('0022_encoding_profile_descriptions', (sqlite) => {
		sqlite.prepare('INSERT INTO credit_templates (id,name,name_key,source,created_at,updated_at) VALUES (?,?,?,?,?,?)').run('custom', BUILTIN_CREDIT_TEMPLATE.name, BUILTIN_CREDIT_TEMPLATE.name.toLowerCase(), 'Authored source', 'before', 'before');
	}, (sqlite) => {
		const rows = sqlite.prepare('SELECT id,name,source,description,is_builtin AS isBuiltin FROM credit_templates').all() as Array<{ id: string; name: string; source: string; description: string; isBuiltin: number }>;
		expect(rows.find((row) => row.id === 'custom')).toEqual({ id: 'custom', name: BUILTIN_CREDIT_TEMPLATE.name, source: 'Authored source', description: '', isBuiltin: 0 });
		expect(rows.find((row) => row.id === BUILTIN_CREDIT_TEMPLATE.id)).toMatchObject({ source: BUILTIN_CREDIT_TEMPLATE.source, description: BUILTIN_CREDIT_TEMPLATE.description, isBuiltin: 1 });
		expect(new Set(rows.map((row) => row.name.toLowerCase())).size).toBe(2);
	});
});
