import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDatabase } from '@server/db/index.js';
import { Repository } from '@server/repository/index.js';

const databases: Array<ReturnType<typeof createDatabase>> = [];

afterEach(() => {
	for (const database of databases.splice(0)) {
		database.close();
	}
});

describe('viewing preference repository', () => {
	it('records an episode against its show and applies the configured half-life', () => {
		const database = createDatabase(':memory:', path.resolve('drizzle'));
		databases.push(database);
		database.sqlite.exec(`
			INSERT INTO libraries
				(id, name, type_key, source_type, source_config)
			VALUES ('library', 'Shows', 'shows', 'on-disk', '{}');
			INSERT INTO media_groups
				(id, library_id, parent_id, stable_key, kind, title, sort_title, metadata)
			VALUES
				('show', 'library', NULL, 'show', 'show', 'Example Show', 'Example Show', '{}'),
				('season', 'library', 'show', 'season', 'season', 'Season 1', 'Season 1', '{}');
			INSERT INTO media_items
				(id, library_id, group_id, stable_key, kind, title, sort_title, relative_path,
				 playback_path, metadata_status, metadata, fingerprint, date_added_at)
			VALUES
				('episode', 'library', 'season', 'episode', 'episode', 'Pilot', 'Pilot',
				 'pilot.mkv', '/pilot.mkv', 'complete', '{}', 'fingerprint',
				 '2025-01-01T00:00:00.000Z');
		`);
		const repository = new Repository(database.db);
		repository.recordViewingPreference(
			'episode',
			2,
			'initial',
			'2026-01-01T00:00:00.000Z',
		);

		const scores = repository.viewingPreferenceScores('2026-06-30T00:00:00.000Z');
		expect(scores.itemScores.episode).toBeCloseTo(1, 5);
		expect(scores.showScores.show).toBeCloseTo(1, 5);
		expect(repository.listViewingPreferences('2026-06-30T00:00:00.000Z', 20)).toEqual([
			expect.objectContaining({
				id: 'show',
				kind: 'show',
				title: 'Example Show',
				previewItemId: 'episode',
				parentTitle: null,
			}),
		]);
	});

	it('reports the newest encounter across every episode in a show', () => {
		const database = createDatabase(':memory:', path.resolve('drizzle'));
		databases.push(database);
		database.sqlite.exec(`
			INSERT INTO libraries
				(id, name, type_key, source_type, source_config)
			VALUES ('library', 'Shows', 'shows', 'on-disk', '{}');
			INSERT INTO media_groups
				(id, library_id, parent_id, stable_key, kind, title, sort_title, metadata)
			VALUES
				('show', 'library', NULL, 'show', 'show', 'Example Show', 'Example Show', '{}'),
				('season', 'library', 'show', 'season', 'season', 'Season 1', 'Season 1', '{}');
			INSERT INTO media_items
				(id, library_id, group_id, stable_key, kind, title, sort_title, relative_path,
				 playback_path, metadata_status, metadata, fingerprint, date_added_at)
			VALUES
				('a-new', 'library', 'season', 'a-new', 'episode', 'Newer', 'Newer',
				 'newer.mkv', '/newer.mkv', 'complete', '{}', 'newer-fingerprint',
				 '2025-01-01T00:00:00.000Z'),
				('z-old', 'library', 'season', 'z-old', 'episode', 'Older', 'Older',
				 'older.mkv', '/older.mkv', 'complete', '{}', 'older-fingerprint',
				 '2025-01-01T00:00:00.000Z');
		`);
		const repository = new Repository(database.db);
		repository.recordViewingPreference('z-old', 1, 'continued', '2026-01-01T00:00:00.000Z');
		repository.recordViewingPreference('a-new', 2, 'initial', '2026-02-01T00:00:00.000Z');

		const [preference] = repository.listViewingPreferences('2026-03-01T00:00:00.000Z', 20);

		expect(preference).toMatchObject({
			id: 'show',
			kind: 'show',
			lastViewedAt: '2026-02-01T00:00:00.000Z',
			previewItemId: 'a-new',
		});
	});

	it('returns the strongest title matches without requiring pagination', () => {
		const database = createDatabase(':memory:', path.resolve('drizzle'));
		databases.push(database);
		database.sqlite.exec(`
			INSERT INTO libraries
				(id, name, type_key, source_type, source_config)
			VALUES ('library', 'Movies', 'movies', 'on-disk', '{}');
			INSERT INTO media_items
				(id, library_id, group_id, stable_key, kind, title, sort_title, relative_path,
				 playback_path, metadata_status, metadata, fingerprint, date_added_at)
			VALUES
				('alpha', 'library', NULL, 'alpha', 'movie', 'Alpha', 'Alpha',
				 'alpha.mkv', '/alpha.mkv', 'complete', '{}', 'alpha-fingerprint',
				 '2025-01-01T00:00:00.000Z'),
				('beta', 'library', NULL, 'beta', 'movie', 'Beta Match', 'Beta Match',
				 'beta.mkv', '/beta.mkv', 'complete', '{}', 'beta-fingerprint',
				 '2025-01-01T00:00:00.000Z'),
				('gamma', 'library', NULL, 'gamma', 'movie', 'Gamma Match', 'Gamma Match',
				 'gamma.mkv', '/gamma.mkv', 'complete', '{}', 'gamma-fingerprint',
				 '2025-01-01T00:00:00.000Z');
		`);
		const repository = new Repository(database.db);
		repository.recordViewingPreference('alpha', 2, 'initial', '2026-01-01T00:00:00.000Z');
		repository.recordViewingPreference('beta', 1, 'initial', '2026-01-01T00:00:00.000Z');
		repository.recordViewingPreference('gamma', 2, 'continued', '2026-01-02T00:00:00.000Z');

		const matches = repository.listViewingPreferences('2026-02-01T00:00:00.000Z', 1, 'match');
		expect(matches.map((row) => row.id)).toEqual(['gamma']);
	});
});
