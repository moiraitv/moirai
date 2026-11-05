import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Temporal } from '@js-temporal/polyfill';
import type { FastifyBaseLogger } from 'fastify';
import { expect, it } from 'vitest';
import sharp from 'sharp';
import { channelCreateSchema, programCreateSchema, type TimelineSegment } from '@moirai/shared';
import { loadConfig } from '@server/config.js';
import { createDatabase } from '@server/db/index.js';
import { Repository } from '@server/repository/index.js';
import { graphicsExamples } from '@server/graphics/examples.js';
import { graphicsFolder, runGraphicsProcess, storeGraphicsAsset } from '@server/graphics/assets.js';
import { openGraphicsClock, type GraphicsClock } from '@server/graphics/clock.js';
import { renderGraphicsPreview } from '@server/graphics/preview.js';
import { parseGraphics } from '@server/graphics/document.js';
import { readCommittedChannelScheduleGuide } from '@server/guide/schedule-guide.js';
import { HardwareAccelerationResolver } from '@server/playback/hardware-acceleration.js';
import { PlayoutPreparationReader } from '@server/playback/playout-preparation.js';
import { PlayoutSynchronizer } from '@server/playback/playout-synchronizer.js';
import { PlaybackEngine } from '@server/playback/playback-engine.js';

const engine = process.env.MOIRAI_TEST_GRAPHICS_ENGINE;

it.skipIf(!engine || !existsSync(engine)).each([
	{ extension: 'apng', rotation: 0, sourceHeight: 180, clockMode: 'live' },
	{ extension: 'apng', rotation: 25, sourceHeight: 180, clockMode: 'none' },
	{ extension: 'mp4', rotation: 25, sourceHeight: 120, clockMode: 'unavailable' },
])('decodes live HLS with a $extension overlay rotated $rotation degrees over a $sourceHeight pixel source with clock $clockMode', async ({ extension, rotation, sourceHeight, clockMode }) => {
	const root = await mkdtemp(path.join(os.tmpdir(), 'moirai-graphics-live-'));
	const database = createDatabase(':memory:', 'drizzle');
	let playback: PlaybackEngine | undefined;
	let clock: GraphicsClock | undefined;
	try {
		const config = loadConfig({ dataDir: root, playbackEnginePath: engine!, timeZone: 'UTC', guideDays: 2 });
		const repository = new Repository(database.db);
		const ffmpeg = process.env.MOIRAI_TEST_FFMPEG ?? 'ffmpeg';
		const media = path.join(root, 'feature.mp4');
		await runGraphicsProcess(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', `color=c=0x203449:s=320x${sourceHeight}:r=30`,
			'-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000', '-t', '90', '-c:v', 'libx264',
			'-preset', 'ultrafast', '-c:a', 'aac', media], { timeout: 10_000 });
		const animation = path.join(root, `overlay.${extension}`);
		await runGraphicsProcess(ffmpeg, [
			'-v', 'error', '-f', 'lavfi', '-i', 'testsrc=s=64x32:r=4',
			'-frames:v', '4', ...(extension === 'apng' ? ['-plays', '0', '-f', 'apng'] : ['-c:v', 'libx264', '-pix_fmt', 'yuv420p']), animation,
		], { timeout: 5000 });
		const asset = await storeGraphicsAsset(graphicsFolder(root), path.basename(animation), await readFile(animation), config.ffprobePath);
		repository.graphics.addAsset(asset);
		const [layer] = parseGraphics(graphicsExamples[0]!.yaml).layers;
		const layers = [{ ...layer, assetId: asset.id, rotation }, ...(clockMode === 'none' ? [] : parseGraphics(graphicsExamples[4]!.yaml).layers)];
		const preset = repository.graphics.save({ name: 'Animated watermark', yaml: `version: 1\nlayers: ${JSON.stringify(layers)}` });
		const program = await repository.createProgram(programCreateSchema.parse({ name: 'Fixture Program', config: {
			type: 'content', source: { type: 'library-query', libraryId: randomUUID(), filter: {} },
			strategy: { type: 'sequential' }, graphicsAssignment: { mode: 'add', presetId: preset.id },
		} }));
		const base = channelCreateSchema.parse({ number: '1', name: 'Fixture TV' });
		const channel = await repository.createChannel({
			...base, video: { ...base.video, width: 320, height: 180, accel: null },
			audio: { ...base.audio, normalizeLoudness: false },
		});

		const today = Temporal.Now.plainDateISO('UTC');
		const start = today.toZonedDateTime('UTC').toInstant().toString();
		const finish = today.add({ days: 2 }).toZonedDateTime('UTC').toInstant().toString();
		const begin = new Date(Date.now() - 1000).toISOString();
		const end = new Date(Date.now() + 85_000).toISOString();
		const common = {
			channelId: channel.id, scheduleLayerId: null, templateId: randomUUID(), slotId: randomUUID(),
			programId: program.id, mediaItemId: null, title: 'Feature', sourceStartSeconds: 0, sourceFinishSeconds: null, truncated: false,
		};
		const primary = { ...common, id: randomUUID(), role: 'primary', start: begin, finish: end, playbackPath: media, sourceFinishSeconds: 86 } as const;
		const segments: TimelineSegment[] = [
			{ ...common, id: randomUUID(), role: 'dead-air', start, finish: begin, playbackPath: null },
			primary,
			{ ...common, id: randomUUID(), role: 'dead-air', start: end, finish, playbackPath: null },
		];
		repository.getChannelSchedule = async () => ({}) as never;
		repository.getTimelineMaterialization = async () => ({ health: 'ready', committedAt: begin, windowStart: start, windowEnd: finish, issues: [] }) as never;
		repository.listMaterializedTimelineSegments = async () => segments.map(segment => ({ segment, mediaSnapshot: null, stateDelta: [], continuation: null }));

		const reader = new PlayoutPreparationReader(repository);
		const workers = {
			databaseBacked: true, playoutRevision: () => '', promotePlayout() {},
			playoutRead: (request: Parameters<PlayoutPreparationReader['read']>[0]) => reader.read(request),
		} as unknown as ConstructorParameters<typeof PlayoutSynchronizer>[8];
		const logger = { debug() {}, info() {}, warn() {}, error() {} } as unknown as FastifyBaseLogger;
		const events = { publish() {} } as unknown as ConstructorParameters<typeof PlaybackEngine>[2];
		const fallback = { resolve: async () => ({ path: media, durationMilliseconds: 90_000, hasAudio: true }) } as unknown as ConstructorParameters<typeof PlayoutSynchronizer>[5];
		const sync = new PlayoutSynchronizer(repository, config.playbackPlayoutDir, 'UTC', 60, async () => {}, fallback, events, logger, workers, 2, graphicsFolder(root));
		if (clockMode === 'live') {
			clock = await openGraphicsClock(config.timeZone);
			sync.graphicsClock = clock;
		}
		playback = new PlaybackEngine(repository, sync, events, logger, new HardwareAccelerationResolver(logger), engine!, config.playbackStreamDir, 'http://127.0.0.1', 15_000, 2000);
		await playback.start();
		if (rotation) {
			await sync.syncChannel(channel.id);
			expect(sync.graphicsIssues.get(channel.id)).toBe(clockMode === 'unavailable' ? 'The live clock could not be prepared.' : undefined);
		}

		const concurrent = Promise.allSettled([
			renderGraphicsPreview(config, repository, parseGraphics(graphicsExamples[0]!.yaml), null, 5000),
			sync.syncChannel(channel.id),
			readCommittedChannelScheduleGuide(repository, 'UTC', channel.id, today.toString(), 2, 2),
		]);
		const started = performance.now();
		await playback.ensureSession(channel);
		const playlist = await readFile(await playback.sessionFile(channel.id, 'live.m3u8'), 'utf8');
		const mediaName = playlist.split('\n').find(line => line.endsWith('.ts'));
		expect(mediaName).toBeTruthy();
		const file = await playback.sessionFile(channel.id, path.basename(mediaName!));
		const { stdout } = await runGraphicsProcess(ffmpeg, ['-v', 'error', '-i', file, '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'png', '-'], { encoding: 'buffer' });
		const frame = sharp(stdout);
		const padded = sourceHeight < 180;
		const region = { left: 260, top: padded ? 113 : 143, width: 47, height: 28 };
		const corner = await frame.clone().extract(region).raw().toBuffer();
		const background = await frame.clone().extract({ ...region, left: 0 }).raw().toBuffer();
		expect(Math.max(...corner)).toBeGreaterThan(Math.max(...background) + 25);
		console.info(`First decoded HLS frame: ${Math.round(performance.now() - started)} ms`);
		const { stdout: later } = await runGraphicsProcess(ffmpeg, [
			'-v', 'error', '-i', file, '-ss', '0.5', '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'png', '-',
		], { encoding: 'buffer' });
		const laterCorner = await sharp(later).extract(region).raw().toBuffer();
		expect(laterCorner.equals(corner)).toBe(false);

		if (clockMode === 'live') {
			const clockRegion = { left: 246, top: 6, width: 65, height: 20 };
			const firstClock = await frame.clone().extract(clockRegion).raw().toBuffer();
			const { stdout: oneSecondLater } = await runGraphicsProcess(ffmpeg, [
				'-v', 'error', '-i', file, '-ss', '1.2', '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'png', '-',
			], { encoding: 'buffer' });
			const laterClock = await sharp(oneSecondLater).extract(clockRegion).raw().toBuffer();
			expect(Math.max(...firstClock)).toBeGreaterThan(180);
			expect(laterClock.equals(firstClock)).toBe(false);
		}

		const folder = sync.channelFolder(channel.id);
		const files = (await readdir(folder)).filter(filename => filename.endsWith('.json'));
		const documents = await Promise.all(files.map(async filename => JSON.parse(await readFile(path.join(folder, filename), 'utf8'))));
		expect(documents.some(document => document.items.some((item: { id: string; graphics?: unknown[] }) =>
			item.id.startsWith(primary.id) && item.graphics?.length))).toBe(true);
		await expect.poll(() => sync.consumerProgress(channel.id), { timeout: 8000 }).toBeTypeOf('number');
		expect((await concurrent).map(result => result.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled']);
	}
	finally {
		await playback?.close();
		await clock?.close();
		database.close();
		await rm(root, { recursive: true, force: true });
	}
}, 45_000);
