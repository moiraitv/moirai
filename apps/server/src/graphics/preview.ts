import { resolveGraphicsPreviewPosition, type GraphicsPreviewPosition } from './preview-context.js';
import { openGraphicsClock, prepareClockStill, type GraphicsClock } from './clock.js';
import { constants } from 'node:fs';
import { access, mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Temporal } from '@js-temporal/polyfill';
import { channelCreateSchema, graphicsSampleStart, hasGraphicsTransform, type Channel, type GraphicsDocument, type GraphicsLayer } from '@moirai/shared';
import { toEtvChannelConfig, toEtvPlayout, type EtvGraphicsLayer, type EtvLocalPlayoutItem, validateEtvDocument } from '@moirai/ersatztv-contract';
import type { AppConfig } from '../config.js';
import type { Repository } from '../repository/index.js';
import { GraphicsError } from '../repository/graphics.js';
import { storageFailureMessage } from '../operations/storage-errors.js';
import { selectVideo } from '../playback/audio-selection.js';
import { playoutItems } from '../playback/playout-output.js';
import { graphicsFolder, runGraphicsProcess } from './assets.js';
import { GraphicsSnapshots } from './snapshots.js';
import { prepareGraphicsLayer, sampleGraphicsContext } from './render.js';
import { GraphicsAttachmentBoundsUnavailable, outputGeometry, transformedGraphics } from './transforms.js';

/** Allow a single disposable engine so preview work cannot saturate playback. */
let previewActive = false;
/** At most one gallery render may be active while an explicit request waits. */
let sampleActive: Promise<Buffer> | undefined;

/** The isolated renderer already has an active or reserved request. */
export class GraphicsPreviewBusyError extends Error {
	readonly statusCode = 503;

	constructor() {
		super('The preview renderer is busy. Try again in a moment.');
	}
}

/** Stage of isolated frame generation for safe diagnostic logging. */
type PreviewStage = 'assets' | 'source' | 'layers' | 'configuration' | 'next' | 'output' | 'frame';

/** A safe preview failure with a stage and reason independent of raw command output. */
export class GraphicsPreviewFailure extends Error {
	constructor(readonly stage: PreviewStage, readonly reason: string, message: string, readonly statusCode: 422 | 503 = 422) {
		super(message);
	}
}

/** Classify preview failures without retaining raw tool output or paths. */
function previewFailure(stage: PreviewStage, error: unknown): GraphicsPreviewFailure {
	if (error instanceof GraphicsPreviewFailure) {
		return error;
	}

	const failure = (error ?? {}) as { code?: string; syscall?: string; killed?: boolean; signal?: string; stderr?: unknown };
	if (stage === 'next' && typeof failure.stderr === 'string' && failure.stderr.includes('unsupported schema version')) {
		return new GraphicsPreviewFailure(stage, 'incompatible_engine', 'The installed Next engine is incompatible. Install the Next version pinned by Moirai and retry.', 503);
	}
	if (failure.code === 'ENOENT' && stage === 'next') {
		return new GraphicsPreviewFailure(stage, 'missing_engine', 'The Next executable could not be found. Check the server’s Next executable setting and retry.', 503);
	}
	if (failure.code === 'ENOENT' && (stage === 'configuration' || failure.syscall?.startsWith('spawn '))) {
		return new GraphicsPreviewFailure(stage, 'missing_tool', 'A preview tool could not be found. Check the server’s FFmpeg and FFprobe settings and retry.', 503);
	}
	if (failure.killed && failure.signal === 'SIGTERM') {
		return new GraphicsPreviewFailure(stage, 'timeout', 'Preview generation timed out. Try again or choose a different preview position.', 503);
	}
	if ((stage === 'assets' && error instanceof GraphicsError) || (stage === 'layers' && failure.code === 'ENOENT')) {
		return new GraphicsPreviewFailure(stage, 'asset_unavailable', 'A graphics asset is missing or incompatible. Replace the affected media or font and retry.');
	}
	const storage = storageFailureMessage(error);
	if (storage) {
		return new GraphicsPreviewFailure(stage, 'storage_unavailable', storage, 503);
	}
	return new GraphicsPreviewFailure(stage, 'unexpected', 'The preview could not be generated. Try again or check the server logs.');
}

/** Resolve explicit paths and PATH wrappers before passing them to Next's file config. */
export async function graphicsPreviewExecutable(executable: string, fallback: string): Promise<string | null> {
	if (executable === fallback) {
		return null;
	}
	if (path.basename(executable) !== executable || path.isAbsolute(executable)) {
		return path.resolve(executable);
	}
	const extensions = process.platform === 'win32' && !path.extname(executable) ? ['.exe', '.com'] : [''];
	for (const directory of (process.env.PATH ?? '/usr/bin:/bin').split(path.delimiter)) {
		for (const extension of extensions) {
			const candidate = path.resolve(directory, executable + extension);
			try {
				if ((await stat(candidate)).isFile()) {
					await access(candidate, constants.X_OK);
					return candidate;
				}
			}
			catch {
				// Continue through PATH when this candidate cannot be executed.
			}
		}
	}
	throw Object.assign(new Error('Graphics preview executable is unavailable'), { code: 'ENOENT' });
}

/** Sample opacity at the requested instant without relying on Next's seek-time fade state. */
export function graphicsPreviewOpacity(layer: GraphicsLayer, startMs: number, elapsedMs: number): number {
	const timing = layer.timing;
	if (timing.mode === 'always') {
		return layer.opacity;
	}
	const wall = timing.mode === 'periodic' && timing.clock === 'wall';
	const clock = wall ? startMs + elapsedMs : elapsedMs;
	const offset = clock - timing.phase;
	const cycleOffset = timing.mode === 'periodic' && (wall || offset >= 0)
		? ((offset % timing.frequency) + timing.frequency) % timing.frequency
		: offset;
	if (cycleOffset < 0 || (timing.mode === 'periodic' && elapsedMs - cycleOffset >= (timing.cutoff ?? Infinity))) {
		return 0;
	}
	const remaining = timing.hold + 2 * timing.fade - cycleOffset;
	return layer.opacity * Math.max(0, Math.min(1, cycleOffset / timing.fade, remaining / timing.fade));
}

/** A selected channel has no committed media at the requested preview position. */
export class GraphicsPreviewMediaUnavailable extends Error {}

/** Render a short isolated Next playout at the requested point in its timeline. */
export async function renderGraphicsPreview(config: AppConfig, repository: Repository, document: GraphicsDocument, channel: Channel | null, elapsedMs: number, showWallClockLayers = false, onWarning?: (message: string) => void, position?: GraphicsPreviewPosition): Promise<Buffer> {
	if (previewActive) {
		throw new GraphicsPreviewBusyError();
	}
	previewActive = true;
	try {
		await sampleActive?.catch(() => undefined);
		return await renderPreview(config, repository, document, channel, elapsedMs, showWallClockLayers, false, onWarning, position);
	}
	finally {
		previewActive = false;
	}
}

/** Render a six-second sample using native fades and animated media. */
export async function renderGraphicsSampleClip(config: AppConfig, repository: Repository, document: GraphicsDocument): Promise<Buffer> {
	if (previewActive || sampleActive) {
		throw new GraphicsPreviewBusyError();
	}
	const visible = document.layers.filter(({ timing }) => timing.mode !== 'periodic' || timing.clock === 'wall' || timing.phase < (timing.cutoff ?? Infinity));
	const firstPhase = Math.min(...visible.flatMap(({ timing }) => timing.mode === 'always' ? [] : [timing.phase]));
	const leadIn = Number.isFinite(firstPhase) ? Math.max(0, firstPhase - 500) : 0;
	const layers = document.layers.map((layer): GraphicsLayer => {
		const { timing } = layer;
		if (!visible.includes(layer)) {
			return { ...layer, opacity: 0, timing: { mode: 'always' } };
		}
		if (layer.kind === 'clock' || timing.mode === 'always') {
			return layer;
		}
		const phase = timing.phase - leadIn;
		return { ...layer, timing: timing.mode === 'once' ? { ...timing, phase } : {
			...timing, phase, clock: 'content',
			...(timing.cutoff === undefined ? {} : { cutoff: Math.max(1, timing.cutoff - leadIn) }),
		} };
	});
	sampleActive = renderPreview(config, repository, { ...document, layers }, null, 0, false, true);
	try {
		return await sampleActive;
	}
	finally {
		sampleActive = undefined;
	}
}

/** Run an admitted preview in an isolated Next process. */
async function renderPreview(config: AppConfig, repository: Repository, document: GraphicsDocument, channel: Channel | null, elapsedMs: number, showWallClockLayers: boolean, clip: boolean, onWarning?: (message: string) => void, position?: GraphicsPreviewPosition): Promise<Buffer> {
	let folder: string | undefined;
	let clock: GraphicsClock | undefined;
	let stage: PreviewStage = 'assets';
	try {
		const assets = repository.graphics.validateAssets(document);
		stage = 'source';
		let context = sampleGraphicsContext;
		const hasClock = document.layers.some(layer => layer.kind === 'clock');
		let startMs = hasClock ? graphicsSampleStart : Date.parse('2026-01-01T14:00:00Z');
		let virtualStart = startMs + elapsedMs;
		const renderDuration = clip ? 6_000 : 4_000;
		let media: EtvLocalPlayoutItem[] = [];
		if (channel) {
			const needsLabels = document.layers.some(layer => layer.kind === 'text');
			const selected = position ?? await resolveGraphicsPreviewPosition(
				repository,
				channel,
				elapsedMs,
				config.timeZone,
				config.publicUrl,
				needsLabels,
			);
			const { segment } = selected;
			virtualStart = selected.at;
			context = selected.preview.context;
			if (needsLabels && selected.preview.availability === 'unavailable' && segment?.role === 'primary') {
				onWarning?.('Graphics guide labels are unavailable at this position.');
			}
			if (!segment || segment.role !== 'primary' || !segment.playbackPath) {
				throw new GraphicsPreviewMediaUnavailable('No committed programme video at this position. Choose another elapsed time or channel.');
			}

			const frameStart = Temporal.Instant.fromEpochMilliseconds(virtualStart);
			const frameFinish = frameStart.add({ milliseconds: renderDuration });
			const paths = segment.playbackParts?.length ? segment.playbackParts.map(part => part.playbackPath) : [segment.playbackPath];
			const metadata = segment.mediaItemId ? await repository.audioMetadata([segment.mediaItemId]).catch(() => new Map()) : new Map();
			const tracks = new Map([[segment.id, paths.map(file => selectVideo(metadata.get(file)))]]);
			media = playoutItems(segment, frameStart, frameFinish, 'preview', undefined, undefined, tracks).filter(item => item.type === 'local');
			if (!media.length) {
				throw new GraphicsPreviewMediaUnavailable('No committed programme video at this position. Choose another elapsed time or channel.');
			}
			const day = frameStart.toZonedDateTimeISO(config.timeZone).toPlainDate();
			const dayStart = day.toZonedDateTime(config.timeZone).toInstant();
			const dayEnd = day.add({ days: 1 }).toZonedDateTime(config.timeZone).toInstant();
			const physicalItem = playoutItems(segment, dayStart, dayEnd, day.toString())
				.find(item => Date.parse(item.start) <= virtualStart && virtualStart < Date.parse(item.finish));
			startMs = Date.parse(physicalItem?.start ?? segment.start);
		}

		const finishMs = virtualStart + renderDuration;
		folder = await mkdtemp(path.join(os.tmpdir(), 'moirai-graphics-'));
		const snapshots = await GraphicsSnapshots.open(path.join(folder, 'graphics'));
		const normalization = channelCreateSchema.parse({ number: '1', name: context.channel.name });
		const video = channel?.video ?? normalization.video;
		const ffmpeg = channel?.ffmpegPath ?? 'ffmpeg';
		const ffprobe = channel?.ffprobePath ?? config.ffprobePath;
		const graphics: EtvGraphicsLayer[] = [];
		const firstMedia = media[0];
		if (firstMedia) {
			await access(firstMedia.path, constants.R_OK).catch((error: NodeJS.ErrnoException) => {
				if (error.code === 'ENOENT') {
					throw new GraphicsPreviewMediaUnavailable('The scheduled video file is missing. Check the channel’s media or choose another preview position.');
				}
				throw error;
			});
		}
		const primary = firstMedia ? { path: firstMedia.path, streamIndex: firstMedia.videoStreamIndex ?? null } : undefined;
		const nativeSize = !video.width || !video.height;
		const { frame: { width, height } } = await outputGeometry(video, primary, false, ffprobe);
		stage = 'layers';
		const transformed = transformedGraphics(
			graphicsFolder(config.dataDir),
			document.layers,
			assets,
			context,
			snapshots,
			video,
			primary,
			ffmpeg,
			ffprobe,
		);
		for (const layer of document.layers) {
			if (layer.kind === 'clock') {
				const zone = channel ? config.timeZone : 'UTC';
				let clockGraphic;
				if (clip) {
					clock ??= await openGraphicsClock(zone);
					clockGraphic = await clock.layer(layer, virtualStart, renderDuration, video, primary, ffprobe);
				}
				else {
					clockGraphic = await prepareClockStill(layer, virtualStart, zone, video, primary, ffprobe, snapshots);
				}
				if (clockGraphic) {
					graphics.push(clockGraphic);
				}
				continue;
			}
			const opacity = showWallClockLayers && layer.timing.mode === 'periodic' && layer.timing.clock === 'wall'
				? layer.opacity
				: graphicsPreviewOpacity(layer, startMs, virtualStart - startMs);
			if (!(clip ? layer.opacity : opacity)) {
				continue;
			}
			const sampled = clip ? layer : { ...layer, opacity, timing: { mode: 'always' } as const };
			try {
				const prepared = (hasGraphicsTransform(sampled) || (nativeSize && sampled.width !== undefined)) ? await transformed(sampled, renderDuration)
					: await prepareGraphicsLayer(graphicsFolder(config.dataDir), sampled, assets, context, renderDuration, snapshots, { width, height }, ffprobe);
				if (prepared) {
					graphics.push(prepared);
				}
			}
			catch (error) {
				if (!(error instanceof GraphicsAttachmentBoundsUnavailable)) {
					throw error;
				}
				onWarning?.(error.message);
			}
		}

		stage = 'configuration';
		const playout = path.join(folder, 'playout');
		const output = path.join(folder, 'output');
		const channelFile = path.join(folder, 'channel.json');
		await mkdir(playout);
		const configuration = toEtvChannelConfig({
			...normalization, id: '2cd52ff4-16dc-4349-9000-166b643d1001',
			createdAt: new Date(startMs).toISOString(), updatedAt: new Date(startMs).toISOString(),
			ffmpegPath: await graphicsPreviewExecutable(ffmpeg, 'ffmpeg'),
			ffprobePath: await graphicsPreviewExecutable(ffprobe, 'ffprobe'),
			audio: { ...normalization.audio, normalizeLoudness: false },
			video: { ...normalization.video, scalingMode: video.scalingMode, width, height, accel: null },
		}, playout);
		(configuration.playout as { virtual_start: string }).virtual_start = new Date(virtualStart).toISOString();
		if (!channel) {
			stage = 'source';
			const source = fileURLToPath(new URL('../../assets/graphics-preview.jpg', import.meta.url));
			const packaged = fileURLToPath(new URL('./assets/graphics-preview.jpg', import.meta.url));
			const still = await access(source, constants.R_OK).then(() => source, () => packaged);
			media = [{
				type: 'local', id: 'graphics-preview', start: new Date(virtualStart).toISOString(),
				finish: new Date(finishMs).toISOString(), path: still, inPointMs: null, outPointMs: null,
			}];
		}
		stage = 'configuration';
		const playoutDocument = toEtvPlayout(media.map(item => ({ ...item, graphics, silentAudio: true })));
		validateEtvDocument('playout', playoutDocument);
		await Promise.all([
			writeFile(channelFile, JSON.stringify(configuration)),
			writeFile(path.join(playout, `${virtualStart}_${finishMs}.json`), JSON.stringify(playoutDocument)),
		]);
		stage = 'next';
		await runGraphicsProcess(config.playbackEnginePath, [
			'run', channelFile, '--output-folder', output, '--number', 'graphics-preview', '--troubleshoot',
		], { timeout: 12_000, maxBuffer: 512 * 1024 });
		stage = 'output';
		const outputFiles = await readdir(output).catch((error: NodeJS.ErrnoException) => {
			if (!clip && error.code === 'ENOENT') {
				return [];
			}
			throw error;
		});
		const segments = outputFiles.filter(file => /^live\d+\.ts$/.test(file)).sort();
		const first = segments[0];
		if (!first) {
			throw new GraphicsPreviewFailure(stage, 'no_frame', 'Next did not produce a preview frame. Try a different elapsed time or preview channel.');
		}
		if (clip) {
			const list = path.join(output, 'segments.txt');
			const destination = path.join(folder, 'sample.mp4');
			await writeFile(list, segments.map(file => `file '${file}'\n`).join(''));
			await runGraphicsProcess(ffmpeg, [
				'-v', 'error', '-f', 'concat', '-safe', '1', '-i', list, '-t', String(renderDuration / 1000),
				'-vf', 'scale=640:360,fps=15', '-an', '-c:v', 'libx264', '-threads', '2', '-preset', 'veryfast',
				'-crf', '24', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', destination,
			], { timeout: 6000, maxBuffer: 128 * 1024 });
			return await readFile(destination);
		}
		stage = 'frame';
		const { stdout } = await runGraphicsProcess(ffmpeg, [
			'-v', 'error', '-i', path.join(output, first), '-frames:v', '1', '-vf', 'scale=960:-2', '-f', 'image2pipe', '-c:v', 'png', '-',
		], { encoding: 'buffer', timeout: 4_000, maxBuffer: 4 * 1024 * 1024 });
		if (!stdout.length) {
			throw new GraphicsPreviewFailure(stage, 'no_frame', 'The preview video contained no readable frame. Try a different elapsed time or preview channel.');
		}
		return stdout;
	}
	catch (error) {
		if (clip || error instanceof GraphicsPreviewMediaUnavailable) {
			throw error;
		}
		throw previewFailure(stage, error);
	}
	finally {
		await clock?.close();
		if (folder) {
			await rm(folder, { recursive: true, force: true });
		}
	}
}
