import path from 'node:path';
import { expect, it } from 'vitest';
import { BUILTIN_CREDIT_TEMPLATE, creditTemplateCreateSchema, channelCreateSchema, type Channel } from '@moirai/shared';
import { createDatabase } from '@server/db/index.js';
import { creditContext } from '@server/playback/credit-context.js';
import { renderCredits } from '@server/playback/credit-render.js';
import { randomUUID } from 'node:crypto';
import { Repository, type DiscoveredItem } from '@server/repository/index.js';

it('protects the built-in design and persists independent editable copies', async () => {
	const database = createDatabase(':memory:', path.resolve('drizzle'));
	try {
		const repo = new Repository(database.db);
		const builtin = (await repo.creditTemplates.list())[0]!;
		expect(builtin).toMatchObject({ ...BUILTIN_CREDIT_TEMPLATE, isBuiltin: true });
		const draft = creditTemplateCreateSchema.parse({ name: 'My credits', description: '  Living room  ', source: builtin.source });
		await expect(repo.creditTemplates.save(draft, builtin.id)).rejects.toThrow('cannot be edited');
		await expect(repo.creditTemplates.delete(builtin.id)).rejects.toThrow('cannot be deleted');
		const copy = await repo.creditTemplates.save(draft);
		expect(copy).toMatchObject({ isBuiltin: false, description: 'Living room', source: builtin.source });
		await repo.creditTemplates.save({ ...draft, source: 'Changed' }, copy.id);
		expect((await repo.creditTemplates.list()).find((entry) => entry.id === builtin.id)).toEqual(builtin);
		await repo.creditTemplates.delete(copy.id);
		expect(await repo.creditTemplates.list()).toEqual([builtin]);
	}
	finally {
		database.close();
	}
});

function item(index: number): DiscoveredItem {
	return {
		id: randomUUID(),
		aliasIds: [],
		groupId: null,
		stableKey: `movie-${index}`,
		kind: 'movie',
		title: `Movie ${index}`,
		sortTitle: `Movie ${index}`,
		relativePath: `Movie ${index}/Movie ${index}.mkv`,
		playbackPath: `/media/Movie ${index}/Movie ${index}.mkv`,
		nfoRelativePath: null,
		plot: null,
		year: null,
		durationMilliseconds: null,
		probeFingerprint: `probe-${index}`,
		probeStatus: 'failed',
		probeUpdatedAt: '2026-08-24T00:00:00.000Z',
		probeErrorCode: 'probe-failed',
		technicalMetadata: {},
		seasonNumber: null,
		episodeNumber: null,
		episodeEndNumber: null,
		edition: null,
		externalIds: [],
		trackNumber: null,
		discNumber: null,
		artists: [],
		multipartStatus: 'none',
		parts: [],
		subtitleTracks: [],
		metadataStatus: 'incomplete',
		metadata: {},
		artworkRelativePath: null,
		fingerprint: `fingerprint-${index}`,
		fileModifiedAt: new Date(2025, 0, index + 1).toISOString(),
		titleBucket: 'M',
		genres: [],
		people: [],
	};
}

it('uses scanned millisecond durations for built-in credit intervals', async () => {
	const database = createDatabase(':memory:', path.resolve('drizzle'));
	try {
		const repo = new Repository(database.db);
		const library = await repo.createLibrary({ name: 'Music', typeKey: 'music-videos', sourceType: 'on-disk', sourceConfig: { scanRoot: '/media', playbackRoot: '/media' }, scanIntervalMinutes: 15, watcherEnabled: false, enabled: true });
		const scanned = { ...item(1), kind: 'music-video', durationMilliseconds: 180_250, probeStatus: 'complete' as const, probeErrorCode: null };
		await repo.reconcileScan(await repo.beginScan(library.id, 'initial'), [], [scanned], [], true);
		const media = (await repo.creditTemplates.media([scanned.id])).get(scanned.id)!;
		expect(media.durationSeconds).toBe(180.25);
		const channel = { ...channelCreateSchema.parse({ name: 'Music', number: '1' }), id: randomUUID(), createdAt: '', updatedAt: '' } as Channel;
		const ass = await renderCredits(BUILTIN_CREDIT_TEMPLATE.source, creditContext(media, channel));
		expect(ass).toContain('0:00:07.00,0:00:17.00');
		expect(ass).toContain('0:02:45.25,0:02:55.25');
	}
	finally {
		database.close();
	}
});
