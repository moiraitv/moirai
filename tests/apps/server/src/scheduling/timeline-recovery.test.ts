import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import {
	channelCreateSchema,
	scheduleTemplateCreateSchema,
	SECONDS_PER_SCHEDULING_DAY,
} from '@moirai/shared';
import { createDatabase } from '@server/db/index.js';
import { readCommittedScheduleGuide } from '@server/guide/schedule-guide.js';
import { MediaProbeError, type MediaProbeResult } from '@server/media/media-probe.js';
import { Repository } from '@server/repository/index.js';
import { discoverOnDisk } from '@server/scanner/on-disk.js';
import { ScannerManager } from '@server/scanner/manager.js';
import { LibrarySourceRegistry } from '@server/scanner/source-registry.js';
import { MAX_MEDIA_SCAN_ATTEMPTS } from '@server/scanner/scan-queue.js';
import { TimelineMaterializer } from '@server/scheduling/timeline-materializer.js';

it('recovers measured media through repeated database restarts without losing guide or cursors', async () => {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(new Date('2026-09-03T12:00:00Z'));
	const root = await realpath(await mkdtemp(path.join(tmpdir(), 'moirai-timeline-recovery-')));
	const databasePath = path.join(root, 'test.sqlite');
	let database = createDatabase(databasePath, path.resolve('drizzle'));
	let repository = new Repository(database.db);
	const events = { publish: vi.fn() };
	try {
		await Promise.all(['Alpha.mp4', 'Beta.mp4', 'Unmeasured.mp4']
			.map((name) => writeFile(path.join(root, name), 'fixture')));
		const library = await repository.createLibrary({
			name: 'Interrupted library', typeKey: 'movies', sourceType: 'on-disk',
			sourceConfig: { scanRoot: root, playbackRoot: '/media' },
			scanIntervalMinutes: 15, watcherEnabled: false, enabled: true,
		});
		let measured = false;
		const probeMedia = vi.fn(async (_root: string, file: string): Promise<MediaProbeResult> => {
			if (!measured || file.endsWith('Unmeasured.mp4')) {
				throw new MediaProbeError('timed-out', 'Fixture probe timed out');
			}

			return {
				durationMilliseconds: 3_600_000, fileSizeBytes: 7, container: 'mp4',
				streams: [], resolution: null, tags: {},
			};
		});
		const scan = async () => {
			const scanner = new ScannerManager(repository, events, new LibrarySourceRegistry([{
				sourceType: 'on-disk',
				usesMediaProbeCache: true,
				validateConfig: async () => undefined,
				configurationImpact: () => 'none',
				discover: (target, context) => discoverOnDisk(target, { ...context, probeMedia }),
			}]));
			try {
				return await scanner.scan(library.id, 'initial');
			}
			finally {
				await scanner.close();
			}
		};
		await scan();
		const program = await repository.createProgram({
			name: 'Measured films',
			config: {
				type: 'content',
				source: { type: 'library-query', libraryId: library.id, kinds: ['movie'], genres: [] },
				strategy: { type: 'sequential' },
			},
		});
		const slotId = randomUUID();
		const template = await repository.createScheduleTemplate(scheduleTemplateCreateSchema.parse({
			name: 'Continuous films',
			slots: [{ id: slotId, startSeconds: 0, programId: program.id }],
			boundaries: [{
				id: randomUUID(), leftSlotId: slotId, rightSlotId: slotId,
				targetSeconds: SECONDS_PER_SCHEDULING_DAY, policy: 'hard',
			}],
		}));
		const channel = await repository.createChannel(channelCreateSchema.parse({ number: '1', name: 'Recovery' }));
		await repository.setChannelSchedule(channel.id, { defaultTemplateId: template.id, layers: [], defaultFiller: null });
		await new TimelineMaterializer(repository, events, 'UTC').runNow();
		const initial = await repository.getTimelineMaterialization(channel.id);
		expect(initial?.health).toBe('ready');
		expect(initial?.issues.filter((issue) => issue.code === 'media-duration-missing')).toHaveLength(3);

		// Abandoned scans must retain the indexed files, their probe facts, and the committed window.
		for (let restart = 0; restart < 2; restart += 1) {
			await repository.beginScan(library.id, 'initial');
			const cached = await repository.listMediaProbeCache(library.id);
			database.close();
			database = createDatabase(databasePath, path.resolve('drizzle'));
			repository = new Repository(database.db);
			expect(await repository.recoverInterruptedScans()).toEqual([library.id]);
			expect(await repository.listMediaProbeCache(library.id)).toEqual(cached);
			expect((await repository.getLibrary(library.id))?.sourceAvailability).toBe('available');
			await new TimelineMaterializer(repository, events, 'UTC').runNow();
			expect(await repository.getTimelineMaterialization(channel.id)).toEqual(initial);
		}

		// A partial recovery should commit the measured subset and keep historical dead air intact.
		measured = true;
		vi.setSystemTime(new Date('2026-09-03T12:15:00Z'));
		expect((await scan()).issues).toEqual(expect.arrayContaining([
			expect.objectContaining({ code: 'media_timed_out', path: 'Unmeasured.mp4' }),
		]));
		await new TimelineMaterializer(repository, events, 'UTC').runNow();
		const materialized = await readCommittedScheduleGuide(repository, 'UTC', '2026-09-03', 1);
		const segments = materialized.guide.channels[0]!.preview.segments;
		const firstPrimary = segments.find((segment) => segment.role === 'primary')!;
		expect(Date.parse(firstPrimary.start) - Date.now()).toBeLessThanOrEqual(1_000);
		expect(segments[0]).toMatchObject({ role: 'dead-air', start: '2026-09-03T00:00:00Z', finish: firstPrimary.start });
		expect(segments.filter((segment) => segment.role === 'primary')
			.every((segment) => ['Alpha', 'Beta'].includes(segment.title))).toBe(true);
		expect(materialized.guide.channels[0]!.preview.issues).toEqual(expect.arrayContaining([
			expect.objectContaining({ code: 'media-duration-missing' }),
		]));
		const state = await repository.getSelectionState(channel.id);
		expect(state.length).toBeGreaterThan(0);

		// The next process reuses successful probes and leaves committed selection state untouched.
		await repository.beginScan(library.id, 'initial');
		database.close();
		database = createDatabase(databasePath, path.resolve('drizzle'));
		repository = new Repository(database.db);
		expect(await repository.recoverInterruptedScans()).toEqual([library.id]);
		probeMedia.mockClear();
		await scan();
		expect(probeMedia).toHaveBeenCalledTimes(MAX_MEDIA_SCAN_ATTEMPTS);
		expect(probeMedia.mock.calls.every(([, file]) => file === path.join(root, 'Unmeasured.mp4'))).toBe(true);
		await new TimelineMaterializer(repository, events, 'UTC').runNow();
		expect(await repository.getSelectionState(channel.id)).toEqual(state);
		expect((await readCommittedScheduleGuide(repository, 'UTC', '2026-09-03', 1))
			.guide.channels[0]!.preview.segments).toEqual(segments);
	}
	finally {
		database.close();
		vi.useRealTimers();
		await rm(root, { recursive: true, force: true });
	}
});
