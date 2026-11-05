import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { graphicsShapeSvg, resolveGraphicsGeometry, type Channel, type GraphicsAsset, type GraphicsGeometry, type GraphicsLayer, type GraphicsRect, type GraphicsSize } from '@moirai/shared';
import type { EtvMediaGraphicsLayer } from '@moirai/ersatztv-contract';
import { graphicsAssetPath, graphicsDecoder, publishGraphicsFile, runGraphicsProcess } from './assets.js';
import { graphicsDimensions } from './dimensions.js';
import { graphicsTiming, prepareGraphicsLayer, type GraphicsContext } from './render.js';
import type { GraphicsSnapshots } from './snapshots.js';

/** Maximum on-disk size of one generated lossless loop. */
const loopLimit = 128 * 1024 * 1024;
/** Source track information used for padded-output placement. */
export interface GraphicsPrimary {
	path: string;
	streamIndex?: number | null;
}

/** Reuse source-track geometry between background preparation and a live tune. */
const primaryTracks = new Map<string, Promise<GraphicsSize & { aspect: number }>>();

/** Read displayed geometry for the chosen stream, invalidating it when the file changes. */
async function primaryGeometry(primary: GraphicsPrimary, ffprobe: string): Promise<GraphicsSize & { aspect: number }> {
	const file = await stat(primary.path);
	const key = JSON.stringify([primary.path, primary.streamIndex, ffprobe, file.ino, file.size, file.mtimeMs, file.ctimeMs]);
	const cached = primaryTracks.get(key);
	if (cached) {
		return await cached;
	}
	if (primaryTracks.size >= 512) {
		primaryTracks.delete(primaryTracks.keys().next().value!);
	}
	const reading = runGraphicsProcess(ffprobe, [
		'-v', 'error', '-protocol_whitelist', 'file', '-select_streams', primary.streamIndex == null ? 'v:0' : String(primary.streamIndex),
		'-show_entries', 'stream=width,height,sample_aspect_ratio,display_aspect_ratio:stream_side_data=rotation', '-of', 'json', primary.path,
	], { timeout: 2000, maxBuffer: 8192 }).then(({ stdout }) => {
		const stream = JSON.parse(stdout).streams?.[0];
		if (!stream?.width || !stream.height) {
			throw new Error('The primary video dimensions are unavailable');
		}
		const [numerator, denominator] = String(stream.sample_aspect_ratio ?? '').split(':').map(Number);
		const [displayWidth, displayHeight] = String(stream.display_aspect_ratio ?? '').split(':').map(Number);
		const aspect = numerator && denominator ? stream.width * numerator / (stream.height * denominator)
			: displayWidth && displayHeight ? displayWidth / displayHeight : stream.width / stream.height;
		const rotation = stream.side_data_list?.find((entry: { rotation?: number }) => entry.rotation !== undefined)?.rotation ?? 0;
		return Math.abs(rotation) % 180 === 90
			? { width: Number(stream.height), height: Number(stream.width), aspect: 1 / aspect }
			: { width: Number(stream.width), height: Number(stream.height), aspect };
	}).catch(error => {
		primaryTracks.delete(key);
		throw error;
	});
	primaryTracks.set(key, reading);
	return await reading;
}

/** An attachment cannot be placed because its target has no measurable geometry. */
export class GraphicsAttachmentBoundsUnavailable extends Error {
	constructor() {
		super('An attached graphics layer was skipped because its target has no measurable bounds.');
	}
}

/** Compute the active video rectangle from the physical track's displayed aspect ratio. */
export async function outputGeometry(video: Channel['video'], primary: GraphicsPrimary | undefined, sourceAligned: boolean, ffprobe: string): Promise<{ frame: GraphicsSize; content: GraphicsRect }> {
	let width = video.width;
	let height = video.height;
	let aspect: number | undefined;
	const nativeSize = !width || !height;
	if (primary && (!width || !height || (sourceAligned && video.scalingMode === 'scale_and_pad'))) {
		const track = await primaryGeometry(primary, ffprobe);
		aspect = track.aspect;
		if (nativeSize) {
			width = track.width;
			height = track.height;
		}
	}
	if (!width || !height) {
		throw new Error('The graphics output dimensions are unavailable');
	}
	const frame = { width, height };
	const fittedWidth = aspect && video.scalingMode === 'scale_and_pad' ? Math.min(width, Math.round(height * aspect)) : width;
	const fittedHeight = aspect && video.scalingMode === 'scale_and_pad' ? Math.min(height, Math.round(width / aspect)) : height;
	const contentWidth = fittedWidth - fittedWidth % 2;
	const contentHeight = fittedHeight - fittedHeight % 2;
	return { frame, content: { width: contentWidth, height: contentHeight, x: Math.floor((width - contentWidth) / 2), y: Math.floor((height - contentHeight) / 2) } };
}

/** Rasterize vector shapes or encode a single transparent cycle of the source. */
async function transformAsset(destination: string, source: string, layer: GraphicsLayer, geometry: GraphicsGeometry, crop: GraphicsRect, animated: boolean, ffmpeg: string): Promise<void> {
	const { size, bounds, matrix } = geometry;
	if (layer.kind === 'shape') {
		const svg = graphicsShapeSvg(layer.shape);
		const body = svg.slice(svg.indexOf('>') + 1, -6);
		const image = `<svg xmlns="http://www.w3.org/2000/svg" width="${crop.width}" height="${crop.height}"><g transform="translate(${bounds.width / 2 - crop.x} ${bounds.height / 2 - crop.y}) matrix(${matrix.join(' ')} 0 0) translate(${-size.width / 2} ${-size.height / 2}) scale(${size.width / layer.shape.width} ${size.height / layer.shape.height})">${body}</g></svg>`;
		await publishGraphicsFile(destination, await sharp(Buffer.from(image)).timeout({ seconds: 1 }).png().toBuffer());
		return;
	}
	await mkdir(path.dirname(destination), { recursive: true });
	const temporary = `${destination}.${randomUUID()}`;
	if (animated && /\.gif$/i.test(source)) {
		const { delay } = await sharp(source, { animated: true }).metadata();
		if (delay && delay.reduce((total, frame) => total + frame, 0) > 60_000) {
			throw new Error('The transformed overlay exceeds the 60 second limit');
		}
	}
	const filter = [
		'format=rgba', `scale=${Math.max(1, Math.round(size.width))}:${Math.max(1, Math.round(size.height))}`,
		'setsar=1', `rotate=${(layer.rotation ?? 0) * Math.PI / 180}:ow=${Math.ceil(bounds.width)}:oh=${Math.ceil(bounds.height)}:c=black@0`,
		`crop=${crop.width}:${crop.height}:${crop.x}:${crop.y}:exact=1`,
	].join(',');
	try {
		await runGraphicsProcess(ffmpeg, [
			'-nostdin', '-v', 'error', '-xerror', '-protocol_whitelist', 'file', '-filter_threads', '1', '-threads', '2', '-noautorotate',
			...(/\.(gif|apng)$/i.test(source) ? ['-ignore_loop', '1'] : []), '-i', source,
			'-map', '0:v:0', '-an', '-sn', '-dn', '-vf', filter,
			...(animated ? ['-t', '60', '-fs', String(loopLimit), '-fps_mode', 'passthrough', '-c:v', 'ffv1', '-pix_fmt', 'bgra', '-f', 'matroska']
				: ['-frames:v', '1', '-c:v', 'png', '-f', 'image2']), '-threads', '2', temporary,
		], { timeout: 15_000, maxBuffer: 64 * 1024 });
		if ((await stat(temporary)).size >= loopLimit) {
			throw new Error('The transformed overlay exceeds the 128 MiB limit');
		}
		await rename(temporary, destination);
	}
	finally {
		await rm(temporary, { force: true });
	}
}

/** Prepare geometry on demand so unrelated layers and invisible targets keep their own timing. */
export function transformedGraphics(root: string, layers: readonly GraphicsLayer[], assets: Map<string, GraphicsAsset>, context: GraphicsContext, snapshots: GraphicsSnapshots, video: Channel['video'], primary: GraphicsPrimary | undefined, ffmpeg: string | null, ffprobe: string) {
	const byId = new Map(layers.map(layer => [layer.id, layer]));
	const sources = new Map<string, Promise<{ source: string; size: GraphicsSize; animated: boolean } | null>>();
	const outputs = new Map<boolean, ReturnType<typeof outputGeometry>>();

	/** Prepare an unscaled source and retain its intrinsic dimensions for dependent layers. */
	async function load(layer: GraphicsLayer) {
		if (layer.kind === 'clock') {
			return null;
		}
		if (layer.kind === 'shape') {
			return { source: layer.id, size: layer.shape, animated: false };
		}
		if (layer.kind === 'media') {
			const asset = assets.get(layer.assetId)!;
			const source = await graphicsAssetPath(root, asset);
			const size = await graphicsDimensions(source, asset.kind === 'video', ffprobe);
			return { source, size, animated: asset.kind === 'video' || asset.format === 'gif' || asset.format === 'apng' };
		}
		const prepared = await prepareGraphicsLayer(root, { ...layer, timing: { mode: 'always' } }, assets, context, 0, snapshots, { width: null, height: null }, ffprobe);
		if (!prepared) {
			return null;
		}
		const source = prepared.source.path;
		return { source, size: await graphicsDimensions(source, false, ffprobe), animated: false };
	}

	return async (layer: GraphicsLayer, duration: number): Promise<EtvMediaGraphicsLayer | null> => {
		const chain: GraphicsLayer[] = [];
		for (let current: GraphicsLayer | undefined = layer; current; current = current.attachment ? byId.get(current.attachment.layerId) : undefined) {
			chain.push(current);
		}
		const sizes = new Map<string, GraphicsSize>();
		for (const entry of chain) {
			let source = sources.get(entry.id);
			if (!source) {
				source = load(entry);
				sources.set(entry.id, source);
			}
			const loaded = await source;
			if (!loaded) {
				if (entry.id === layer.id) {
					return null;
				}
				throw new GraphicsAttachmentBoundsUnavailable();
			}
			sizes.set(entry.id, loaded.size);
		}
		const loaded = (await sources.get(layer.id))!;
		const sourceAligned = chain.at(-1)!.withinSource;
		let output = outputs.get(sourceAligned);
		if (!output) {
			output = outputGeometry(video, primary, sourceAligned, ffprobe);
			outputs.set(sourceAligned, output);
		}
		const { frame, content } = await output;
		const geometry = resolveGraphicsGeometry(chain, sizes, frame, content).get(layer.id);
		if (!geometry) {
			throw new GraphicsAttachmentBoundsUnavailable();
		}
		const { bounds, size } = geometry;
		if (size.width > 3840 || size.height > 2160 || bounds.width * bounds.height > 24_000_000) {
			throw new Error('The transformed overlay exceeds the graphics dimension limit');
		}
		const left = Math.round(bounds.x);
		const top = Math.round(bounds.y);
		const x = Math.max(0, left);
		const y = Math.max(0, top);
		const crop = { x: x - left, y: y - top, width: Math.min(frame.width, left + Math.ceil(bounds.width)) - x,
			height: Math.min(frame.height, top + Math.ceil(bounds.height)) - y };
		if (crop.width <= 0 || crop.height <= 0) {
			return null;
		}
		const hash = createHash('sha256').update(JSON.stringify([2, layer.kind === 'shape' ? layer.shape : path.basename(loaded.source), size, geometry.matrix, crop])).digest('hex');
		const source = await snapshots.use(`${hash}.${loaded.animated ? 'mkv' : 'png'}`, async destination =>
			await transformAsset(destination, loaded.source, layer, geometry, crop, loaded.animated, ffmpeg ?? await graphicsDecoder(ffprobe)));
		const timing = graphicsTiming(layer.timing, duration);
		return {
			kind: 'media', source: { source_type: 'local', path: source }, location: 'top_left',
			horizontal_margin_percent: 100 * x / frame.width, vertical_margin_percent: 100 * y / frame.height,
			opacity_percent: layer.opacity, within_source_content: false, ...(timing ? { timing } : {}),
		};
	};
}
