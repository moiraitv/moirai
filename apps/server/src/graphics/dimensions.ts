import sharp from 'sharp';
import { runGraphicsProcess } from './assets.js';

/** Dimensions of the first graphics video stream or image frame. */
interface Dimensions {
	width: number;
	height: number;
}

/** Reuse metadata for immutable files without accumulating paths across schedule changes. */
const dimensions = new Map<string, Promise<Dimensions>>();

/** Read dimensions without decoding an entire overlay during playout preparation. */
async function readDimensions(source: string, video: boolean, ffprobe: string): Promise<Dimensions> {
	if (video) {
		const { stdout } = await runGraphicsProcess(ffprobe, [
			'-v', 'error', '-protocol_whitelist', 'file', '-select_streams', 'v:0',
			'-show_entries', 'stream=width,height', '-of', 'json', source,
		], { timeout: 2000, maxBuffer: 4096 });
		return JSON.parse(stdout).streams?.[0] ?? { width: 0, height: 0 };
	}
	const image = await sharp(source, { limitInputPixels: 24_000_000 }).metadata();
	return { width: image.width, height: image.pageHeight ?? image.height };
}

/** Mirror Next's proportional scaling and reject sizes that exceed the output frame. */
export async function validateGraphicsScale(
	source: string,
	video: boolean,
	ffprobe: string,
	percent: number | undefined,
	output: { width: number | null; height: number | null },
): Promise<void> {
	if (percent === undefined || output.width === null || output.height === null) {
		return;
	}
	assertGraphicsScale(await graphicsDimensions(source, video, ffprobe), percent, output);
}

/** Share intrinsic dimensions between native validation and transformed placement. */
export async function graphicsDimensions(source: string, video: boolean, ffprobe: string): Promise<Dimensions> {
	const key = JSON.stringify([source, video ? ffprobe : null]);
	let reading = dimensions.get(key);
	if (!reading) {
		if (dimensions.size >= 512) {
			dimensions.delete(dimensions.keys().next().value!);
		}
		reading = readDimensions(source, video, ffprobe).catch(error => {
			dimensions.delete(key);
			throw error;
		});
		dimensions.set(key, reading);
	}
	return await reading;
}

/** Validate known image dimensions before writing a generated snapshot. */
export function assertGraphicsScale(
	{ width, height }: Dimensions,
	percent: number | undefined,
	output: { width: number | null; height: number | null },
): void {
	if (percent === undefined || output.width === null || output.height === null) {
		return;
	}
	const scaledWidth = Math.round(Math.fround(Math.fround(Math.fround(percent) / 100) * Math.fround(output.width)));
	const scaledHeight = Math.round(Math.fround(scaledWidth * Math.fround(height / width)));
	if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1
		|| scaledWidth < 1 || scaledHeight < 1
		|| scaledWidth + scaledWidth % 2 > output.width || scaledHeight + scaledHeight % 2 > output.height) {
		throw new Error('Scaled graphics dimensions exceed the output frame or round to zero');
	}
}
