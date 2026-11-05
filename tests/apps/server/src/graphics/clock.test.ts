import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { expect, it } from 'vitest';
import { channelCreateSchema, graphicsTimeFormatter } from '@moirai/shared';
import { loadConfig } from '@server/config.js';
import { createDatabase } from '@server/db/index.js';
import { openGraphicsClock } from '@server/graphics/clock.js';
import { runGraphicsProcess } from '@server/graphics/assets.js';
import { parseGraphics } from '@server/graphics/document.js';
import { graphicsExamples } from '@server/graphics/examples.js';
import { renderGraphicsSampleClip } from '@server/graphics/preview.js';
import { Repository } from '@server/repository/index.js';

const engine = process.env.MOIRAI_TEST_GRAPHICS_ENGINE;

it('formats midnight and the spring-forward boundary in the broadcast zone', () => {
	const format = graphicsTimeFormatter('America/Los_Angeles', true);
	expect(format.format(new Date('2026-01-02T08:00:00Z'))).toBe('00:00:00');
	expect(format.format(new Date('2026-03-08T09:59:59Z'))).toBe('01:59:59');
	expect(format.format(new Date('2026-03-08T10:00:00Z'))).toBe('03:00:00');
});

it.skipIf(!engine || !existsSync(engine))('streams signed clock pixels with alpha and the correct mid-item timestamp', async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), 'moirai-clock-stream-'));
	const service = await openGraphicsClock('America/Los_Angeles');
	try {
		const [layer] = parseGraphics(graphicsExamples[4]!.yaml).layers;
		if (layer?.kind !== 'clock') {
			throw new Error('Expected the clock example');
		}
		const video = channelCreateSchema.parse({ number: '1', name: 'Test' }).video;
		const start = Date.parse('2026-03-08T09:59:54Z');
		const canvas = (await service.layer(layer, start, 9000, video, undefined, 'ffprobe'))!;
		const alternate = (await service.layer(layer, start + 6000, 3000, video, undefined, 'ffprobe'))!;
		const rejected = await fetch(canvas.source.uri + '0', { headers: { 'x-etv-offset-ms': '6000' } });
		expect(rejected.status).toBe(404);
		const download = async (uri: string, offset: number) => {
			const response = await fetch(uri, { headers: { 'x-etv-offset-ms': String(offset) }, signal: AbortSignal.timeout(20_000) });
			expect(response.ok).toBe(true);
			const file = path.join(directory, `clock-${offset}.apng`);
			await writeFile(file, Buffer.from(await response.arrayBuffer()));
			return file;
		};
		const frame = async (file: string) => {
			const { stdout } = await runGraphicsProcess('ffmpeg', [
				'-v', 'error', '-i', file, '-frames:v', '1', '-c:v', 'png', '-f', 'image2pipe', '-',
			], { encoding: 'buffer', timeout: 8000 });
			return await sharp(stdout).raw().toBuffer();
		};
		const actual = await frame(await download(canvas.source.uri, 6000));
		expect(actual).toEqual(await frame(await download(alternate.source.uri, 0)));
		expect(actual[3]).toBe(0);
		const { stdout: timestamps } = await runGraphicsProcess('ffprobe', [
			'-v', 'error', '-show_entries', 'frame=pts_time', '-of', 'csv=p=0', await download(canvas.source.uri, 6250),
		], { timeout: 8000 });
		expect(timestamps.trim().split('\n').map(Number).slice(0, 3)).toEqual([0, 0.75, 1.75]);
	}
	finally {
		await service.close();
		await rm(directory, { recursive: true, force: true });
	}
}, 60_000);

it.skipIf(!engine || !existsSync(engine))('renders an advancing clock through Next in the sample gallery clip', async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), 'moirai-clock-test-'));
	const database = createDatabase(':memory:', 'drizzle');
	try {
		const config = loadConfig({ dataDir: root, playbackEnginePath: engine! });
		const document = parseGraphics(graphicsExamples[4]!.yaml);
		const clip = await renderGraphicsSampleClip(config, new Repository(database.db), document);
		const file = path.join(root, 'clock.mp4');
		await writeFile(file, clip);
		const { stdout } = await runGraphicsProcess('ffmpeg', [
			'-v', 'error', '-i', file, '-vf', 'crop=145:50:480:6,fps=1', '-f', 'framemd5', '-',
		], { timeout: 10_000 });
		expect(new Set(stdout.split('\n').filter(line => /^0,/.test(line)).map(line => line.split(',').at(-1))).size).toBeGreaterThan(2);
	}
	finally {
		database.close();
		await rm(root, { recursive: true, force: true });
	}
}, 35_000);
