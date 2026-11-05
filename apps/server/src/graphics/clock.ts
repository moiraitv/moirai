import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { crc32 } from 'node:zlib';
import sharp from 'sharp';
import { z } from 'zod';
import { graphicsClockSize, graphicsClockSvg, graphicsTimeFormatter, resolveGraphicsGeometry, type Channel, type GraphicsLayer } from '@moirai/shared';
import type { EtvCanvasGraphicsLayer, EtvMediaGraphicsLayer } from '@moirai/ersatztv-contract';
import { publishGraphicsFile } from './assets.js';
import type { GraphicsSnapshots } from './snapshots.js';
import { outputGeometry, type GraphicsPrimary } from './transforms.js';

/** An always-on badge whose pixels are generated against the broadcast timeline. */
type ClockLayer = Extract<GraphicsLayer, { kind: 'clock' }>;

/** Maximum supported item duration, including a long broadcast day across a clock change. */
const maximumDuration = 26 * 60 * 60 * 1000;

/** Bound the clock producer to a small region and a single frame per second. */
const clockRequest = z.object({
	start: z.number().int().min(0).max(8_640_000_000_000_000 - maximumDuration),
	duration: z.number().int().positive().max(maximumDuration),
	width: z.number().int().min(2).max(1024),
	height: z.number().int().min(2).max(288),
	color: z.string().regex(/^#[0-9a-f]{6}$/i),
	background: z.string().regex(/^#[0-9a-f]{6}$/i),
	backgroundOpacity: z.number().min(0).max(100),
	opacity: z.number().min(0).max(100),
});

/** Signed settings for a single clock region. */
type ClockRequest = z.infer<typeof clockRequest>;

/** Encode a PNG chunk for the incremental APNG stream. */
function pngChunk(type: string, payload: Buffer): Buffer {
	const chunk = Buffer.alloc(12 + payload.length);
	chunk.writeUInt32BE(payload.length);
	chunk.write(type, 4, 'ascii');
	payload.copy(chunk, 8);
	chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
	return chunk;
}

/** Stream the timed badge as APNG without launching a second FFmpeg for each viewer. */
async function* clockFrames(settings: ClockRequest, offset: number, formatter: Intl.DateTimeFormat, signal: AbortSignal) {
	const start = settings.start + offset;
	// Supply a final frame past the item end so downstream framesync covers the tail.
	const end = Math.ceil((settings.start + settings.duration) / 1000) * 1000 + 1000;
	let sequence = 0;
	for (let instant = start; instant <= end && !signal.aborted; instant = Math.floor(instant / 1000) * 1000 + 1000) {
		const first = sequence === 0;
		const svg = graphicsClockSvg(settings, formatter.format(instant), settings.width, settings.height, settings.opacity);
		const png = await sharp(Buffer.from(svg)).ensureAlpha().png({ compressionLevel: 1 }).toBuffer();
		if (first) {
			yield png.subarray(0, 33); // Signature and IHDR.
			const animation = Buffer.alloc(8);
			animation.writeUInt32BE((end - Math.floor(start / 1000) * 1000) / 1000 + 1);
			animation.writeUInt32BE(1, 4);
			yield pngChunk('acTL', animation);
		}

		const control = Buffer.alloc(26);
		control.writeUInt32BE(sequence++);
		control.writeUInt32BE(settings.width, 4);
		control.writeUInt32BE(settings.height, 8);
		control.writeUInt16BE(1000 - instant % 1000, 20);
		control.writeUInt16BE(1000, 22);
		yield pngChunk('fcTL', control);

		for (let cursor = 33; cursor < png.length;) {
			const length = png.readUInt32BE(cursor);
			if (png.toString('ascii', cursor + 4, cursor + 8) === 'IDAT') {
				const data = png.subarray(cursor + 8, cursor + 8 + length);
				if (first) {
					yield pngChunk('IDAT', data);
				}
				else {
					const payload = Buffer.alloc(4 + length);
					payload.writeUInt32BE(sequence++);
					data.copy(payload, 4);
					yield pngChunk('fdAT', payload);
				}
			}
			cursor += 12 + length;
		}
	}
	yield pngChunk('IEND', Buffer.alloc(0));
}

/** Resolve a single badge region for still previews and the live canvas. */
async function clockRegion(layer: ClockLayer, video: Channel['video'], primary: GraphicsPrimary | undefined, probe: string) {
	const { frame, content } = await outputGeometry(video, primary, layer.withinSource, probe);
	const geometry = resolveGraphicsGeometry([layer], new Map([[layer.id, graphicsClockSize]]), frame, content).get(layer.id);
	if (!geometry || !layer.opacity || geometry.bounds.x >= frame.width || geometry.bounds.y >= frame.height) {
		return null;
	}
	const { size, bounds } = geometry;
	return {
		size, frame,
		x: Math.min(frame.width - 2, Math.round(bounds.x / 2) * 2),
		y: Math.min(frame.height - 2, Math.round(bounds.y / 2) * 2),
	};
}

/** Render the exact selected second into the still preview with the same badge placement. */
export async function prepareClockStill(
	layer: ClockLayer, 
	instant: number, 
	timeZone: string, 
	video: Channel['video'],
	primary: GraphicsPrimary | undefined, 
	probe: string, 
	snapshots: GraphicsSnapshots,
): Promise<EtvMediaGraphicsLayer | null> {
	const region = await clockRegion(layer, video, primary, probe);
	if (!region) {
		return null;
	}
	const { x, y, size, frame } = region;
	const svg = graphicsClockSvg(layer.badge, graphicsTimeFormatter(timeZone, true).format(instant), size.width, size.height, layer.opacity);
	const key = createHash('sha256').update(svg).digest('hex');
	const file = await snapshots.use(`${key}.png`, async destination => {
		await publishGraphicsFile(destination, await sharp(Buffer.from(svg)).png().toBuffer());
	});
	return {
		kind: 'media', source: { source_type: 'local', path: file }, location: 'top_left', within_source_content: false,
		opacity_percent: 100, horizontal_margin_percent: x * 100 / frame.width, vertical_margin_percent: y * 100 / frame.height,
	};
}

/** Open the private clock renderer after verifying its badge rasterizer. */
export async function openGraphicsClock(timeZone: string) {
	await sharp(Buffer.from(graphicsClockSvg({ color: '#FFFFFF', background: '#000000', backgroundOpacity: 100 }, '00:00:00'))).png().toBuffer();

	const secret = randomBytes(32);
	const formatter = graphicsTimeFormatter(timeZone, true);
	const active = new Set<AbortController>();
	const server = createServer((request, response) => {
		const match = /^\/clock\/([\w-]{1,512})\.([a-f0-9]{64})$/.exec(request.url ?? '');
		const token = match?.[1];
		if (request.method !== 'GET' || !token
			|| !timingSafeEqual(Buffer.from(match[2]!, 'hex'), signature(token))) {
			response.writeHead(404).end();
			return;
		}

		const settings = clockRequest.safeParse(JSON.parse(Buffer.from(token, 'base64url').toString('utf8')));
		const offsetHeader = request.headers['x-etv-offset-ms'];
		const offset = typeof offsetHeader === 'string' && /^\d{1,8}$/.test(offsetHeader) ? Number(offsetHeader) : NaN;
		if (!settings.success || !Number.isFinite(offset) || offset >= settings.data.duration || active.size >= 256) {
			response.writeHead(503).end();
			return;
		}

		response.writeHead(200, { 'Content-Type': 'image/apng', 'Cache-Control': 'no-store' });
		response.flushHeaders();
		const controller = new AbortController();
		active.add(controller);
		response.once('close', () => controller.abort());
		void pipeline(Readable.from(clockFrames(settings.data, offset, formatter, controller.signal)), response, { signal: controller.signal }).catch(() => response.destroy()).finally(() => active.delete(controller));
	});

	/** Authenticate a bounded render request without storing state for every published item. */
	function signature(token: string): Buffer {
		return createHmac('sha256', secret).update(token).digest();
	}

	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			server.off('error', reject);
			resolve();
		});
	});
	const port = (server.address() as AddressInfo).port;

	return {
		/** Produce an internal source descriptor with probe metadata and no disk lease. */
		async layer(layer: ClockLayer, start: number, duration: number, video: Channel['video'], primary: GraphicsPrimary | undefined, probe: string): Promise<EtvCanvasGraphicsLayer | null> {
			const region = await clockRegion(layer, video, primary, probe);
			if (!region) {
				return null;
			}
			const { x, y, size } = region;
			const settings = clockRequest.parse({
				...layer.badge, start, duration, width: size.width, height: size.height,
				opacity: layer.opacity,
			});
			const token = Buffer.from(JSON.stringify(settings)).toString('base64url');
			return {
				kind: 'canvas', location: 'top_left', layout: { mode: 'region', origin: { x, y } },
				source: {
					source_type: 'http', uri: `http://127.0.0.1:${port}/clock/${token}.${signature(token).toString('hex')}`,
					reconnect: false, timeout_us: 5_000_000,
					probe_hint: { format_name: 'apng', video: [{
						codec: 'apng', width: size.width, height: size.height, pix_fmt: 'rgba', stream_index: 0, frame_rate: '1/1',
					}] },
				},
			};
		},
		/** End producers before releasing the loopback listener. */
		async close(): Promise<void> {
			for (const controller of active) {
				controller.abort();
			}
			await new Promise<void>(resolve => server.close(() => resolve()));
		},
	};
}

/** Clock renderer shared by playout and isolated previews. */
export type GraphicsClock = Awaited<ReturnType<typeof openGraphicsClock>>;
