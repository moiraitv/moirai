import { GraphicsClockSizeError, type GraphicsClock } from './clock.js';
import { validateEtvDocument, type EtvGraphicsLayer, type EtvMediaGraphicsLayer } from '@moirai/ersatztv-contract';
import { emptyGraphicsContext, hasGraphicsTransform, type Channel, type GraphicsContext } from '@moirai/shared';
import type { PreparedGraphicsPresets } from '../repository/graphics.js';
import { graphicsAssignmentsForSegment, graphicsPreparationBudget, isGraphicsEligible, type GraphicsSegment } from './segments.js';
import { GraphicsSnapshotBusyError, type GraphicsSnapshots } from './snapshots.js';
import { graphicsContexts, graphicsTiming, prepareGraphicsLayer } from './render.js';
import { GraphicsAttachmentBoundsUnavailable, transformedGraphics } from './transforms.js';

/** A schema-validated document emitted by the scheduling worker. */
interface PlayoutDocument {
	items: Array<{ id: string; start: string; finish: string; source?: { path?: string }; tracks?: { video?: { stream_index?: number } }; graphics?: EtvGraphicsLayer[] }>;
}

/** Return the remaining graphics preparation budget, including any live promotion. */
function remainingBudget(started: number, live: () => boolean): number {
	return (live() ? graphicsPreparationBudget.live : graphicsPreparationBudget.background) - (performance.now() - started);
}

/** Yield publication when graphics work cannot finish within the active tune budget. */
async function prepareWithinBudget<T>(
	started: number,
	live: () => boolean,
	prepare: () => Promise<T>,
): Promise<T | undefined> {
	if (remainingBudget(started, live) <= 0) {
		return undefined;
	}

	const work = prepare();
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			work,
			new Promise<undefined>(resolve => {
				timer = setInterval(() => {
					if (remainingBudget(started, live) <= 0) {
						resolve(undefined);
					}
				}, 15);
				timer.unref();
			}),
		]);
	}
	finally {
		clearInterval(timer);
	}
}

/** Decorate local playout items without changing the scheduler or its worker protocol. */
export async function decorateGraphics(
	root: string,
	presets: PreparedGraphicsPresets,
	channel: Channel,
	segments: GraphicsSegment[],
	files: Map<string, string>,
	live: () => boolean,
	snapshots: GraphicsSnapshots,
	ffprobe = 'ffprobe',
	timeZone = 'UTC',
	clock?: GraphicsClock,
	contexts?: Map<string, GraphicsContext>,
): Promise<{ files: Map<string, string>; issue?: string; used: Map<string, number> }> {
	const started = performance.now();
	let issue: string | undefined;
	const segmentById = new Map(segments.map(segment => [segment.id, segment]));
	const output = new Map<string, string>();
	const used = new Map<string, number>();
	const now = Date.now();
	const resolved = new Map<string, EtvMediaGraphicsLayer | null>();
	let scheduleOnly: Map<string, GraphicsContext> | undefined;

	const documents = [...files].map(([filename, json]) => ({ filename, document: JSON.parse(json) as PlayoutDocument }));
	const candidates = documents.flatMap(({ document }) => document.items).filter(item => Date.parse(item.finish) > now);
	for (const item of candidates) {
		// Physical parts and daily clips append their identifiers to the original segment ID.
		const segment = segmentById.get(item.id.replace(/:\d{4}-\d{2}-\d{2}(?::\d+)?$/, ''));
		if (!segment || !isGraphicsEligible(segment)) {
			continue;
		}
		const preparedContext = contexts?.get(segment.id);
		const duration = Date.parse(item.finish) - Date.parse(item.start);
		for (const assignment of graphicsAssignmentsForSegment(channel, segment)) {
			const preset = presets.get(assignment.id);
			if (!preset) {
				issue ??= 'An assigned graphics preset or its assets are unavailable';
				continue;
			}
			const hasText = assignment.text && preset.document.layers.some(layer => layer.kind === 'text');
			const context = preparedContext ?? (hasText && !contexts
				? (scheduleOnly ??= graphicsContexts(channel, segments, timeZone)).get(segment.id) : undefined) ?? emptyGraphicsContext(channel);
			const textDelayed = hasText && contexts !== undefined && !preparedContext;
			const layers = textDelayed ? preset.document.layers.filter(layer => layer.kind !== 'text') : preset.document.layers;
			if (textDelayed && layers.length !== preset.document.layers.length) {
				issue ??= 'Graphics guide labels are still being prepared';
			}
			const primary = item.source?.path ? { path: item.source.path, streamIndex: item.tracks?.video?.stream_index ?? null } : undefined;
			const probe = channel.ffprobePath ?? ffprobe;
			const transformed = transformedGraphics(root, layers, preset.assets, context, snapshots, channel.video, primary, channel.ffmpegPath, probe);
			const nativeSize = channel.video.width == null || channel.video.height == null;
			const sourcePlacement = nativeSize || (channel.video.scalingMode === 'scale_and_pad' && layers.some(layer => layer.withinSource));
			for (const layer of layers) {
				if (layer.kind === 'text' && !assignment.text) {
					continue;
				}
				if (layer.kind === 'clock') {
					if (remainingBudget(started, live) <= 0) {
						issue ??= 'Some graphics are still being prepared';
						continue;
					}

					try {
						if (!clock) {
							throw new Error('Clock renderer unavailable');
						}
						const prepare = () => clock.layer(layer, Date.parse(item.start), duration, channel.video, primary, probe);
						const needsProbe = !channel.video.width || !channel.video.height
							|| (layer.withinSource && channel.video.scalingMode === 'scale_and_pad');
						const canvas = needsProbe ? await prepareWithinBudget(started, live, prepare) : await prepare();
						if (canvas === undefined) {
							issue ??= 'Some graphics are still being prepared';
						}
						if (canvas) {
							(item.graphics ??= []).push(canvas);
						}
					}
					catch (error) {
						issue ??= error instanceof GraphicsClockSizeError ? error.message : 'The live clock could not be prepared.';
					}
					continue;
				}
				try {
					// A layer's timing is identical across items that pass the appearance limit.
					graphicsTiming(layer.timing, duration);
					const advanced = hasGraphicsTransform(layer) || (nativeSize && layer.width !== undefined);
					const key = JSON.stringify([assignment.id, layer.id, layer.kind === 'text' || (advanced && layer.attachment) ? context : null,
						advanced && sourcePlacement ? primary : null]);
					if (!resolved.has(key)) {
						const prepared = await prepareWithinBudget(
							started,
							live,
							() => advanced ? transformed(layer, duration) : prepareGraphicsLayer(root, layer, preset.assets, context, duration, snapshots, channel.video, probe),
						);
						if (prepared === undefined) {
							issue ??= 'Some graphics are still being prepared';
							continue;
						}
						resolved.set(key, prepared);
					}
					const graphics = resolved.get(key);
					if (graphics) {
						(item.graphics ??= []).push(graphics);
						const file = graphics.source.path;
						used.set(file, Math.max(used.get(file) ?? 0, Date.parse(item.finish)));
					}
				}
				catch (error) {
					issue ??= error instanceof GraphicsSnapshotBusyError ? 'Some graphics are still being prepared'
						: error instanceof GraphicsAttachmentBoundsUnavailable ? error.message
							: 'An overlay could not be prepared. Check its assets and template in Graphics.';
				}
			}
		}
	}
	for (const { filename, document } of documents) {
		validateEtvDocument('playout', document);
		output.set(filename, `${JSON.stringify(document, null, 2)}\n`);
	}
	return { files: output, used, ...(issue ? { issue } : {}) };
}
