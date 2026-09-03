import { mkdtemp, mkdir, opendir, readdir, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Library } from '@moirai/shared';
import { MAX_MEDIA_DURATION_MILLISECONDS, MAX_NFO_BYTES, MEDIA_EXTENSIONS } from '@moirai/shared';
import { MediaProbeError } from '@server/media/media-probe.js';
import { checkOnDiskPresence, discoverOnDisk } from '@server/scanner/on-disk.js';
import { MAX_MEDIA_SCAN_ATTEMPTS } from '@server/scanner/scan-queue.js';

const roots: string[] = [];
async function library(typeKey = 'movies'): Promise<Library> {
	const root = await mkdtemp(path.join(tmpdir(), 'moirai-scan-'));
	roots.push(root);
	return {
		id: crypto.randomUUID(),
		name: 'Fixture',
		typeKey,
		sourceType: 'on-disk',
		sourceConfig: { scanRoot: root, playbackRoot: '/media' },
		scanIntervalMinutes: 15,
		watcherEnabled: true,
		enabled: true,
		watcherStatus: 'stopped',
		sourceAvailability: 'available',
		sourceAvailabilityUpdatedAt: null,
		reconciliationStatus: 'idle',
		pendingRemovalCount: 0,
		lastScanStartedAt: null,
		lastScanCompletedAt: null,
		lastChangeDetectedAt: null,
		lastIndexedChangeAt: null,
		itemCount: 0,
		warningCount: 0,
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	};
}
afterEach(async () => {
	const { rm } = await import('node:fs/promises');
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('discoverOnDisk', () => {
	it('retries probes after the inventory and persists only final outcomes and file progress', async () => {
		const fixture = await library();
		const names = ['Recovered.mp4', 'Healthy.mp4', 'Exhausted.mp4'];
		await Promise.all(names.map((name) => writeFile(path.join(fixture.sourceConfig.scanRoot, name), 'video')));
		const calls: string[] = [];
		const attempts = new Map<string, number>();
		const onProgress = vi.fn();
		const probeMedia = vi.fn(async (_root: string, file: string) => {
			const name = path.basename(file);
			calls.push(name);
			const attempt = (attempts.get(name) ?? 0) + 1;
			attempts.set(name, attempt);
			if (name === 'Exhausted.mp4' || (name === 'Recovered.mp4' && attempt < MAX_MEDIA_SCAN_ATTEMPTS)) {
				throw new MediaProbeError('timed-out', 'Media probe exceeded its time limit');
			}

			return { durationMilliseconds: 90_125, fileSizeBytes: 5, container: 'mp4', streams: [], resolution: null, tags: {} };
		});

		const result = await discoverOnDisk(fixture, { probeMedia, onProgress });

		expect(new Set(calls.slice(0, names.length))).toEqual(new Set(names));
		expect(attempts.get('Healthy.mp4')).toBe(1);
		expect(attempts.get('Recovered.mp4')).toBe(MAX_MEDIA_SCAN_ATTEMPTS);
		expect(attempts.get('Exhausted.mp4')).toBe(MAX_MEDIA_SCAN_ATTEMPTS);
		expect(result.items).toHaveLength(names.length);
		expect(new Set(result.items.map((item) => item.id)).size).toBe(names.length);
		expect(result.items.find((item) => item.relativePath === 'Recovered.mp4')).toMatchObject({
			probeStatus: 'complete', probeErrorCode: null, durationMilliseconds: 90_125,
		});
		expect(result.items.find((item) => item.relativePath === 'Exhausted.mp4')).toMatchObject({
			probeStatus: 'failed', probeErrorCode: 'timed-out', durationMilliseconds: null,
		});
		expect(result.issues.filter((issue) => issue.code === 'media_timed_out')).toEqual([
			expect.objectContaining({ path: 'Exhausted.mp4' }),
		]);
		expect(result.issues.filter((issue) => issue.code === 'nfo_missing')).toHaveLength(names.length);
		expect(onProgress.mock.calls.map(([progress]) => progress.processedCount)).toEqual([0, 1, 2, 3, 3]);
		expect(onProgress.mock.calls.every(([progress]) => progress.totalCount === names.length)).toBe(true);
		expect(result.traversalComplete).toBe(true);
	});

	it('cancels deferred probes without starting another pass or reporting completion', async () => {
		const fixture = await library();
		await Promise.all(['Alpha.mp4', 'Beta.mp4'].map((name) =>
			writeFile(path.join(fixture.sourceConfig.scanRoot, name), 'video')));
		const controller = new AbortController();
		const cancelled = new Error('Scan cancelled');
		const onProgress = vi.fn();
		const probeMedia = vi.fn().mockImplementationOnce(async () => {
			throw new MediaProbeError('timed-out', 'Transient failure');
		}).mockImplementationOnce(async () => {
			controller.abort(cancelled);
			throw cancelled;
		});

		await expect(discoverOnDisk(fixture, { probeMedia, onProgress, signal: controller.signal }))
			.rejects.toBe(cancelled);
		expect(probeMedia).toHaveBeenCalledTimes(2);
		expect(onProgress.mock.calls.every(([progress]) => progress.phase === 'processing'
			&& progress.processedCount < progress.totalCount)).toBe(true);
	});

	it.each(['resource-exhausted', 'executable-unavailable'] as const)(
		'finalizes deferred probes without retrying a later %s failure',
		async (code) => {
			const fixture = await library();
			await Promise.all(['Alpha.mp4', 'Beta.mp4'].map((name) =>
				writeFile(path.join(fixture.sourceConfig.scanRoot, name), 'video')));
			const probeMedia = vi.fn()
				.mockRejectedValueOnce(new MediaProbeError('timed-out', 'Transient failure'))
				.mockRejectedValue(new MediaProbeError(code, 'System-wide probe failure'));

			const result = await discoverOnDisk(fixture, { probeMedia });

			expect(probeMedia).toHaveBeenCalledTimes(2);
			expect(result.items).toHaveLength(2);
			expect(result.items.every((item) => item.probeErrorCode === code)).toBe(true);
			expect(result.issues.filter((issue) => issue.code.startsWith('media_'))).toEqual([
				expect.objectContaining({ path: null, code: `media_${code.replaceAll('-', '_')}`, severity: 'error' }),
			]);
		},
	);

	it('assembles multipart durations only after failed parts finish retrying', async () => {
		const fixture = await library();
		await Promise.all(['Film-cd1.mkv', 'Film-cd2.mkv'].map((name) =>
			writeFile(path.join(fixture.sourceConfig.scanRoot, name), 'video')));
		let failed = false;
		const probeMedia = vi.fn(async (_root: string, file: string) => {
			if (file.endsWith('cd1.mkv') && !failed) {
				failed = true;
				throw new MediaProbeError('timed-out', 'Transient failure');
			}
			return { durationMilliseconds: 90_000, fileSizeBytes: 5, container: 'mkv', streams: [], resolution: null, tags: {} };
		});

		const result = await discoverOnDisk(fixture, { probeMedia });

		expect(result.items).toHaveLength(1);
		expect(result.items[0]).toMatchObject({ durationMilliseconds: 180_000, probeStatus: 'complete', multipartStatus: 'complete' });
		expect(result.items[0]?.parts.map((part) => part.durationSeconds)).toEqual([90, 90]);
		expect(result.issues.some((issue) => issue.code === 'media_timed_out')).toBe(false);
	});

	it('checks only supplied missing-item paths and accepts any present multipart file', async () => {
		const fixture = await library();
		await writeFile(path.join(fixture.sourceConfig.scanRoot, 'Restored.mkv'), 'video');

		const result = await checkOnDiskPresence(fixture.sourceConfig.scanRoot, [
			{ itemId: 'restored', stableKey: 'restored', relativePaths: ['Restored.mkv'] },
			{ itemId: 'missing', stableKey: 'missing', relativePaths: ['Missing.mkv'] },
			{
				itemId: 'multipart',
				stableKey: 'multipart',
				relativePaths: ['Missing Part 1.mkv', 'Restored.mkv'],
			},
		]);

		expect(result.observations).toEqual([
			{ itemId: 'restored', status: 'present' },
			{ itemId: 'missing', status: 'absent' },
			{ itemId: 'multipart', status: 'present' },
		]);
	});

	it('processes duplicate filesystem entries only once', async () => {
		const fixture = await library();
		const mediaPath = path.join(fixture.sourceConfig.scanRoot, 'Duplicate.mp4');
		await writeFile(mediaPath, 'video');
		const entries = await readdir(fixture.sourceConfig.scanRoot, { withFileTypes: true });
		const openDirectory = vi.fn(async () => ({
			async *[Symbol.asyncIterator]() {
				for (const entry of entries) {
					yield entry;
					yield entry;
				}
			},
		}) as unknown as Awaited<ReturnType<typeof opendir>>);
		const onProgress = vi.fn();
		const probeMedia = vi.fn().mockResolvedValue({
			durationMilliseconds: 60_000,
			fileSizeBytes: 5,
			container: 'mov,mp4',
			streams: [{ type: 'video' as const, codec: 'h264', width: 1280, height: 720 }],
			resolution: { width: 1280, height: 720 },
		});

		const result = await discoverOnDisk(fixture, { openDirectory, onProgress, probeMedia });

		expect(result.items).toHaveLength(1);
		expect(probeMedia).toHaveBeenCalledOnce();
		expect(onProgress.mock.calls[0]?.[0]).toEqual({
			phase: 'processing',
			processedCount: 0,
			totalCount: 1,
		});
		expect(onProgress.mock.calls.at(-1)?.[0]).toEqual({
			phase: 'finalizing',
			processedCount: 1,
			totalCount: 1,
		});
	});

	it('reports exact processing progress after discovering the media inventory', async () => {
		const fixture = await library();
		await writeFile(path.join(fixture.sourceConfig.scanRoot, 'Alpha.mp4'), 'video');
		await writeFile(path.join(fixture.sourceConfig.scanRoot, 'Beta.mp4'), 'video');
		const onProgress = vi.fn();

		await discoverOnDisk(fixture, {
			discoveryConcurrency: 2,
			onProgress,
		});

		expect(onProgress.mock.calls[0]?.[0]).toEqual({
			phase: 'processing',
			processedCount: 0,
			totalCount: 2,
		});
		expect(onProgress.mock.calls.map(([progress]) => progress)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ phase: 'processing', processedCount: 1, totalCount: 2 }),
				expect.objectContaining({ phase: 'processing', processedCount: 2, totalCount: 2 }),
			]),
		);
		expect(onProgress.mock.calls.at(-1)?.[0]).toEqual({
			phase: 'finalizing',
			processedCount: 2,
			totalCount: 2,
		});
	});

	it('uses measured duration instead of NFO runtime and reuses an unchanged probe', async () => {
		const fixture = await library();
		const mediaPath = path.join(fixture.sourceConfig.scanRoot, 'Measured.mp4');
		await writeFile(mediaPath, 'video');
		await writeFile(
			path.join(fixture.sourceConfig.scanRoot, 'Measured.nfo'),
			'<movie><title>Measured</title><runtime>999</runtime></movie>',
		);
		const probeMedia = vi.fn().mockResolvedValue({
			durationMilliseconds: 90_125,
			fileSizeBytes: 5,
			container: 'mov,mp4',
			streams: [{ type: 'video' as const, codec: 'h264', width: 1280, height: 720 }],
			resolution: { width: 1280, height: 720 },
		});
		const first = await discoverOnDisk(fixture, { probeMedia });
		expect(first.items[0]).toMatchObject({
			durationMilliseconds: 90_125,
			probeStatus: 'complete',
			metadata: { reportedRuntimeMinutes: 999 },
		});
		const item = first.items[0]!;
		const second = await discoverOnDisk(fixture, {
			probeMedia,
			probeCache: new Map([['Measured.mp4', {
				relativePath: 'Measured.mp4',
				probeFingerprint: item.probeFingerprint,
				durationMilliseconds: item.durationMilliseconds,
				probeStatus: 'complete',
				probeUpdatedAt: item.probeUpdatedAt,
				probeErrorCode: null,
				technicalMetadata: item.technicalMetadata,
			}]]),
		});
		expect(second.items[0]?.durationMilliseconds).toBe(90_125);
		expect(probeMedia).toHaveBeenCalledOnce();
	});

	it('collapses a system-wide probe resource failure into one partial-scan diagnostic', async () => {
		const fixture = await library();
		await writeFile(path.join(fixture.sourceConfig.scanRoot, 'Alpha.mp4'), 'video');
		await writeFile(path.join(fixture.sourceConfig.scanRoot, 'Beta.mp4'), 'video');
		const probeMedia = vi.fn().mockRejectedValue(
			new MediaProbeError('resource-exhausted', 'System resource capacity prevented media inspection'),
		);

		const result = await discoverOnDisk(fixture, { discoveryConcurrency: 2, probeMedia });

		expect(result.items.every((item) => item.probeStatus === 'failed')).toBe(true);
		expect(result.issues.filter((issue) => issue.code === 'media_resource_exhausted')).toEqual([
			expect.objectContaining({ path: null, severity: 'error' }),
		]);
	});

	it('uses public extensions and maps scan paths to ETV playback paths', async () => {
		const fixture = await library();
		const extension = MEDIA_EXTENSIONS.find((candidate) => candidate === '.mkv')!;
		const folder = path.join(fixture.sourceConfig.scanRoot, 'Film');
		await mkdir(folder);
		await writeFile(path.join(folder, `Film${extension}`), 'video');
		await writeFile(
			path.join(folder, 'Film.nfo'),
			'<movie><title>Film Title</title><year>2020</year></movie>',
		);
		await writeFile(path.join(folder, 'poster.jpg'), 'image');

		const result = await discoverOnDisk(fixture);
		expect(result.items).toHaveLength(1);
		expect(result.items[0]).toMatchObject({
			title: 'Film Title',
			relativePath: `Film/Film${extension}`,
			playbackPath: `/media/Film/Film${extension}`,
			metadataStatus: 'complete',
			artworkRelativePath: 'Film/poster.jpg',
		});
	});

	it('resolves relative poster references from nested NFO artwork', async () => {
		const fixture = await library();
		const folder = path.join(fixture.sourceConfig.scanRoot, 'Referenced');
		const artworkFolder = path.join(folder, 'images');
		await mkdir(artworkFolder, { recursive: true });
		await writeFile(path.join(folder, 'Referenced.mkv'), 'video');
		await writeFile(
			path.join(folder, 'Referenced.nfo'),
			'<movie><title>Referenced</title><art><poster>images/key-art.jpg</poster></art></movie>',
		);
		await writeFile(path.join(artworkFolder, 'key-art.jpg'), 'image');

		const result = await discoverOnDisk(fixture);

		expect(result.items[0]?.artworkRelativePath).toBe('Referenced/images/key-art.jpg');
	});

	it('indexes a playable file with filename metadata when NFO is missing', async () => {
		const fixture = await library();
		await writeFile(path.join(fixture.sourceConfig.scanRoot, 'The_No_NFO.mp4'), 'video');
		const result = await discoverOnDisk(fixture);
		expect(result.items[0]).toMatchObject({
			title: 'The No NFO',
			sortTitle: 'No NFO',
			titleBucket: 'N',
			metadataStatus: 'incomplete',
		});
		expect(result.issues.some((issue) => issue.code === 'nfo_missing')).toBe(true);
	});

	it('deduplicates repeated people by type and normalized name', async () => {
		const fixture = await library();
		await writeFile(path.join(fixture.sourceConfig.scanRoot, 'Credits.mp4'), 'video');
		await writeFile(
			path.join(fixture.sourceConfig.scanRoot, 'Credits.nfo'),
			`<movie>
				<title>Credits</title>
				<director>Jane Doe</director>
				<director> jane doe </director>
				<actor><name>Alex Smith</name><order>4</order></actor>
				<actor><name>ALEX SMITH</name><role>Lead</role><order>1</order></actor>
			</movie>`,
		);

		const result = await discoverOnDisk(fixture);

		expect(result.items[0]?.people).toEqual([
			{
				personType: 'director',
				name: 'Jane Doe',
				normalizedName: 'jane doe',
				role: null,
				sortOrder: null,
			},
			{
				personType: 'actor',
				name: 'Alex Smith',
				normalizedName: 'alex smith',
				role: 'Lead',
				sortOrder: 1,
			},
		]);
	});

	it('changes item fingerprints when normalized metadata changes without source stat changes', async () => {
		const fixture = await library();
		const mediaPath = path.join(fixture.sourceConfig.scanRoot, 'Credits.mp4');
		const nfoPath = path.join(fixture.sourceConfig.scanRoot, 'Credits.nfo');
		await writeFile(mediaPath, 'video');
		await writeFile(
			nfoPath,
			'<movie><actor><name>Featured Actor</name><sortorder>9</sortorder></actor></movie>',
		);
		const originalNfoStat = await stat(nfoPath);
		const first = await discoverOnDisk(fixture);

		await writeFile(
			nfoPath,
			'<movie><actor><name>Featured Actor</name><sortorder>1</sortorder></actor></movie>',
		);
		await utimes(nfoPath, originalNfoStat.atime, originalNfoStat.mtime);
		const second = await discoverOnDisk(fixture);

		expect(second.items[0]?.people[0]?.sortOrder).toBe(1);
		expect(second.items[0]?.fingerprint).not.toBe(first.items[0]?.fingerprint);
	});

	it('skips oversized sidecars with a bounded diagnostic', async () => {
		const fixture = await library();
		await writeFile(path.join(fixture.sourceConfig.scanRoot, 'Large.mp4'), 'video');
		await writeFile(
			path.join(fixture.sourceConfig.scanRoot, 'Large.nfo'),
			`<movie><plot>${'x'.repeat(MAX_NFO_BYTES)}</plot></movie>`,
		);
		const result = await discoverOnDisk(fixture);
		expect(result.items[0]?.metadataStatus).toBe('invalid');
		expect(result.issues).toEqual(
			expect.arrayContaining([expect.objectContaining({ code: 'nfo_too_large' })]),
		);
	});

	it('builds show and season groups using Kodi metadata', async () => {
		const fixture = await library('shows');
		const show = path.join(fixture.sourceConfig.scanRoot, 'Signal');
		await mkdir(path.join(show, 'Season 01'), { recursive: true });
		await writeFile(
			path.join(show, 'tvshow.nfo'),
			'<tvshow><title>The Signal</title><year>2019</year><uniqueid>signal</uniqueid></tvshow>',
		);
		await writeFile(path.join(show, 'Season 01', 'Signal.S01E02.mkv'), 'video');
		await writeFile(
			path.join(show, 'Season 01', 'Signal.S01E02.nfo'),
			'<episodedetails><title>A Second Light</title><aired>2021-03-04</aired><season>1</season><episode>2</episode></episodedetails>',
		);
		const result = await discoverOnDisk(fixture);
		expect(result.groups.map((group) => group.kind)).toEqual(['show', 'season']);
		expect(result.groups.find((group) => group.kind === 'show')).toMatchObject({
			title: 'The Signal',
			sortTitle: 'Signal',
			year: 2019,
			metadata: { yearEnd: 2021 },
		});
		expect(result.items[0]).toMatchObject({
			title: 'A Second Light',
			sortTitle: 'Second Light',
			titleBucket: 'S',
			year: 2021,
			seasonNumber: 1,
			episodeNumber: 2,
		});
	});

	it('keeps show folders separate when their provider IDs collide', async () => {
		const fixture = await library('shows');
		for (const folder of ['Alpha', 'Beta']) {
			const show = path.join(fixture.sourceConfig.scanRoot, folder);
			await mkdir(show, { recursive: true });
			await writeFile(
				path.join(show, 'tvshow.nfo'),
				`<tvshow><title>${folder}</title><uniqueid type="tmdb">42</uniqueid></tvshow>`,
			);
			await writeFile(path.join(show, `${folder}.S01E01.mkv`), 'video');
			await writeFile(
				path.join(show, `${folder}.S01E01.nfo`),
				`<episodedetails><title>${folder} Pilot</title><season>1</season><episode>1</episode></episodedetails>`,
			);
		}

		const result = await discoverOnDisk(fixture);
		const shows = result.groups.filter((group) => group.kind === 'show');
		expect(shows).toHaveLength(2);
		expect(new Set(result.items.map((item) => item.groupId))).toHaveProperty('size', 2);
		expect(result.conflicts).toEqual([
			expect.objectContaining({ kind: 'show-external-id', provider: 'tmdb', externalId: '42' }),
		]);
		expect(result.issues).toEqual(
			expect.arrayContaining([expect.objectContaining({ code: 'show_external_id_conflict' })]),
		);
	});

	it('reports malformed TV-show metadata while retaining folder-derived groups', async () => {
		const fixture = await library('shows');
		const show = path.join(fixture.sourceConfig.scanRoot, 'Broken Signal');
		await mkdir(path.join(show, 'Season 01'), { recursive: true });
		await writeFile(path.join(show, 'tvshow.nfo'), 'not an XML metadata document');
		await writeFile(path.join(show, 'Season 01', 'Broken.Signal.S01E01.mkv'), 'video');
		await writeFile(
			path.join(show, 'Season 01', 'Broken.Signal.S01E01.nfo'),
			'<episodedetails><title>Fallback Episode</title><season>1</season><episode>1</episode></episodedetails>',
		);

		const result = await discoverOnDisk(fixture);
		expect(result.groups.find((group) => group.kind === 'show')?.title).toBe('Broken Signal');
		expect(result.issues).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					path: 'Broken Signal/tvshow.nfo',
					code: 'tvshow_nfo_invalid',
					severity: 'warning',
				}),
			]),
		);
	});

	it('collapses complete multipart videos and inventories logical and part subtitles', async () => {
		const fixture = await library();
		const folder = path.join(fixture.sourceConfig.scanRoot, 'Long Film');
		await mkdir(folder);
		await writeFile(path.join(folder, 'Long Film-cd1.mkv'), 'part one');
		await writeFile(path.join(folder, 'Long Film-cd2.mkv'), 'part two');
		await writeFile(path.join(folder, 'Long Film.nfo'), '<movie><title>Long Film</title></movie>');
		await writeFile(path.join(folder, 'Long Film.en.default.srt'), 'subtitle');
		await writeFile(path.join(folder, 'Long Film-cd2.es.forced.ass'), 'subtitle');
		const probeMedia = vi.fn(async (_root: string, file: string) => ({
			durationMilliseconds: file.endsWith('cd1.mkv') ? 60_000 : 90_000,
			fileSizeBytes: 8,
			container: 'matroska',
			streams: [{
				index: 0,
				type: 'video' as const,
				codec: 'h264',
				width: 1280,
				height: 720,
				language: null,
				title: null,
				isDefault: false,
				isForced: false,
				isHearingImpaired: false,
				isCommentary: false,
			}],
			resolution: { width: 1280, height: 720 },
			tags: {},
		}));

		const result = await discoverOnDisk(fixture, { probeMedia });

		expect(result.items).toHaveLength(1);
		expect(result.items[0]).toMatchObject({
			title: 'Long Film',
			multipartStatus: 'complete',
			durationMilliseconds: 150_000,
			technicalMetadata: { fileSizeBytes: 16 },
		});
		expect(result.items[0]?.aliasIds).toHaveLength(1);
		expect(result.items[0]?.parts).toEqual([
			expect.objectContaining({ number: 1, relativePath: 'Long Film/Long Film-cd1.mkv' }),
			expect.objectContaining({
				number: 2,
				relativePath: 'Long Film/Long Film-cd2.mkv',
				subtitleTracks: [expect.objectContaining({ language: 'es', isForced: true })],
			}),
		]);
		expect(result.items[0]?.subtitleTracks).toEqual([
			expect.objectContaining({ language: 'en', isDefault: true, partNumber: null }),
		]);
	});

	it('keeps an oversized multipart duration out of the scheduling catalog', async () => {
		const fixture = await library();
		await writeFile(path.join(fixture.sourceConfig.scanRoot, 'Long Film-cd1.mkv'), 'part one');
		await writeFile(path.join(fixture.sourceConfig.scanRoot, 'Long Film-cd2.mkv'), 'part two');
		const probeMedia = vi.fn().mockResolvedValue({
			durationMilliseconds: Math.floor(MAX_MEDIA_DURATION_MILLISECONDS / 2) + 1,
			fileSizeBytes: 8,
			container: 'matroska',
			streams: [],
			resolution: { width: 1280, height: 720 },
			tags: {},
		});

		const result = await discoverOnDisk(fixture, { probeMedia });

		expect(result.items[0]).toMatchObject({
			multipartStatus: 'complete',
			durationMilliseconds: null,
			probeStatus: 'failed',
			probeErrorCode: 'multipart-duration-invalid',
		});
		expect(result.issues).toContainEqual(expect.objectContaining({
			code: 'multipart_duration_invalid',
		}));
	});

	it('retains invalid multipart videos for browsing with an unschedulable duration', async () => {
		const fixture = await library();
		await writeFile(path.join(fixture.sourceConfig.scanRoot, 'Broken-part1.mp4'), 'video');
		await writeFile(path.join(fixture.sourceConfig.scanRoot, 'Broken-part3.mp4'), 'video');
		const probeMedia = vi.fn().mockResolvedValue({
			durationMilliseconds: 60_000,
			fileSizeBytes: 5,
			container: 'mov,mp4',
			streams: [],
			resolution: { width: 1280, height: 720 },
			tags: {},
		});

		const result = await discoverOnDisk(fixture, { probeMedia });

		expect(result.items).toHaveLength(1);
		expect(result.items[0]).toMatchObject({
			title: 'Broken',
			multipartStatus: 'incomplete',
			durationMilliseconds: null,
			probeStatus: 'failed',
			probeErrorCode: 'multipart-incomplete',
		});
		expect(result.issues).toEqual(expect.arrayContaining([
			expect.objectContaining({ code: 'multipart_incomplete' }),
		]));
	});

	it('builds artist and album groups and applies music-video tag precedence', async () => {
		const fixture = await library('music-videos');
		const album = path.join(fixture.sourceConfig.scanRoot, 'The Folder Artist', 'Folder Album');
		await mkdir(album, { recursive: true });
		await writeFile(path.join(album, '04 - Filename Title.mkv'), 'video');
		await writeFile(
			path.join(album, 'The Folder Artist - Folder Album.nfo'),
			'<album><title>An NFO Album</title><year>2022</year><thumb>album-cover.jpg</thumb></album>',
		);
		await writeFile(path.join(album, 'album-cover.jpg'), 'art');
		await writeFile(
			path.join(fixture.sourceConfig.scanRoot, 'The Folder Artist', 'folder.jpg'),
			'artist art',
		);
		const probeMedia = vi.fn().mockResolvedValue({
			durationMilliseconds: 180_000,
			fileSizeBytes: 5,
			container: 'matroska',
			streams: [],
			resolution: { width: 1920, height: 1080 },
			tags: {
				title: 'A Tagged Title',
				artist: 'Tagged Artist; Guest Artist',
				album: 'Tagged Album',
				track: '4/10',
				disc: '2/2',
				date: '2023-04-01',
				genre: 'Rock; Live',
			},
		});

		const result = await discoverOnDisk(fixture, { probeMedia });

		expect(result.groups.map((group) => group.kind)).toEqual(['artist', 'album']);
		expect(result.groups.find((group) => group.kind === 'artist')).toMatchObject({
			title: 'The Folder Artist',
			sortTitle: 'Folder Artist',
			artworkRelativePath: 'The Folder Artist/folder.jpg',
		});
		expect(result.groups.find((group) => group.kind === 'album')).toMatchObject({
			title: 'An NFO Album',
			sortTitle: 'NFO Album',
			year: 2022,
			artworkRelativePath: 'The Folder Artist/Folder Album/album-cover.jpg',
		});
		expect(result.items[0]).toMatchObject({
			title: 'A Tagged Title',
			sortTitle: 'Tagged Title',
			titleBucket: 'T',
			year: 2023,
			trackNumber: 4,
			discNumber: 2,
			artists: ['Tagged Artist', 'Guest Artist'],
		});
		expect(result.items[0]?.genres.map((genre) => genre.name)).toEqual(['Rock', 'Live']);
	});

	it('ignores symlinked item and show sidecars outside the library root', async () => {
		const fixture = await library('shows');
		const outside = await mkdtemp(path.join(tmpdir(), 'moirai-outside-nfo-'));
		roots.push(outside);
		const show = path.join(fixture.sourceConfig.scanRoot, 'Safe Show');
		const season = path.join(show, 'Season 01');
		await mkdir(season, { recursive: true });
		const outsideShowNfo = path.join(outside, 'tvshow.nfo');
		const outsideEpisodeNfo = path.join(outside, 'episode.nfo');
		await writeFile(outsideShowNfo, '<tvshow><title>Leaked Show</title></tvshow>');
		await writeFile(
			outsideEpisodeNfo,
			'<episodedetails><title>Leaked Episode</title></episodedetails>',
		);
		await symlink(outsideShowNfo, path.join(show, 'tvshow.nfo'));
		await writeFile(path.join(season, 'Safe.Show.S01E01.mkv'), 'video');
		await symlink(outsideEpisodeNfo, path.join(season, 'Safe.Show.S01E01.nfo'));

		const result = await discoverOnDisk(fixture);
		expect(result.groups.find((group) => group.kind === 'show')?.title).toBe('Safe Show');
		expect(result.items[0]).toMatchObject({
			title: 'Episode 1',
			metadataStatus: 'incomplete',
		});
		expect(result.issues.map((issue) => issue.code)).toContain('nfo_missing');
	});
});
