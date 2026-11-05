import { graphicsFontFamily } from './font-family.js';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { execFile } from 'node:child_process';
import { access, mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import sharp from 'sharp';
import type { GraphicsAsset } from '@moirai/shared';

/** Maximum upload size, shared by the multipart handler and asset validator. */
export const GRAPHICS_UPLOAD_LIMIT = 32 * 1024 * 1024;

/** Run bounded probes and isolated preview processes without shell interpolation. */
export const runGraphicsProcess = promisify(execFile);

/** Locate graphics assets under the server data directory. */
export function graphicsFolder(dataDir: string): string {
	return path.resolve(dataDir, 'graphics');
}

/** Publish a complete file before any document can refer to it. */
export async function publishGraphicsFile(destination: string, data: Buffer): Promise<void> {
	await mkdir(path.dirname(destination), { recursive: true });
	const temporary = `${destination}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporary, data, { mode: 0o600, flag: 'wx' });
		await rename(temporary, destination);
	}
	finally {
		await rm(temporary, { force: true });
	}
}

/** Resolve the immutable path for an uploaded or packaged graphics asset. */
export async function graphicsAssetPath(root: string, asset: GraphicsAsset): Promise<string> {
	if (asset.protected) {
		const name = asset.format === 'gif' ? 'graphics-corner-bug.gif' : 'graphics-watermark.png';
		const source = fileURLToPath(new URL(`../../assets/${name}`, import.meta.url));
		const packaged = fileURLToPath(new URL(`./assets/${name}`, import.meta.url));
		try {
			await access(source);
			return source;
		}
		catch {
			await access(packaged);
			return packaged;
		}
	}

	const filename = path.join(root, 'assets', `${asset.id}.${asset.format}`);
	await access(filename);
	return filename;
}

/** Remove an original after its database entry is retired; playout uses independent snapshots. */
export async function removeGraphicsOriginal(root: string, asset: GraphicsAsset): Promise<void> {
	await rm(path.join(root, 'assets', `${asset.id}.${asset.format}`), { force: true });
}

/** Recover interrupted asset writes or retirements before admitting uploads and playback. */
export async function reconcileGraphicsStorage(root: string, registered: GraphicsAsset[]): Promise<void> {
	const directory = path.join(root, 'assets');
	const live = new Set(registered.filter(asset => !asset.protected).map(asset => `${asset.id}.${asset.format}`));
	const files = await readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
		if (error.code === 'ENOENT') {
			return [];
		}
		throw error;
	});
	for (const file of files) {
		if (file.isFile() && !live.has(file.name)
			&& /^[a-f0-9-]{36}\.(?:png|apng|jpeg|gif|webp|mp4|webm|ttf|otf|upload)(?:\.[a-f0-9-]{36}\.tmp)?$/.test(file.name)) {
			await rm(path.join(directory, file.name), { force: true });
		}
	}
}

/** Prefer the probe installation's FFmpeg when available, otherwise use PATH. */
export async function graphicsDecoder(ffprobe: string): Promise<string> {
	const name = path.basename(ffprobe);
	if (!/^ffprobe(?:\.exe)?$/i.test(name) || name === ffprobe) {
		return 'ffmpeg';
	}
	const candidate = path.resolve(path.dirname(ffprobe), name.replace(/^ffprobe/i, 'ffmpeg'));
	try {
		if ((await stat(candidate)).isFile()) {
			await access(candidate, constants.X_OK);
			return candidate;
		}
	}
	catch {
		// A separately installed probe does not override the PATH decoder.
	}
	return 'ffmpeg';
}

/** Read the animation frame count from a PNG's control chunk before its image data. */
function pngAnimationFrames(data: Buffer): number | undefined {
	if (data.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
		return undefined;
	}
	for (let offset = 8; offset + 12 <= data.length;) {
		const size = data.readUInt32BE(offset);
		const type = data.toString('ascii', offset + 4, offset + 8);
		if (type === 'IDAT' || type === 'IEND') {
			break;
		}
		if (type === 'acTL') {
			return size === 8 && offset + 20 <= data.length ? data.readUInt32BE(offset + 8) : 0;
		}
		offset += size + 12;
	}
	return undefined;
}

/** Decode one APNG cycle without looping, and verify the declared frame count. */
async function validateApng(file: string, frames: number, ffprobe: string): Promise<void> {
	const { stdout } = await runGraphicsProcess(await graphicsDecoder(ffprobe), [
		'-v', 'error', '-nostdin', '-xerror', '-progress', 'pipe:1', '-protocol_whitelist', 'file',
		'-err_detect', 'crccheck+explode', '-threads', '2', '-f', 'apng', '-ignore_loop', '1',
		'-i', file, '-frames:v', String(frames + 1), '-fps_mode', 'passthrough', '-f', 'null', '-',
	], { timeout: 5000, maxBuffer: 128 * 1024 });
	const decoded = Number([...stdout.matchAll(/^frame=\s*(\d+)$/gm)].at(-1)?.[1]);
	const duration = Number([...stdout.matchAll(/^out_time_us=(\d+)$/gm)].at(-1)?.[1]);
	if (decoded !== frames || !Number.isFinite(duration) || duration > 60_000_000) {
		throw new Error('Use a decodable APNG animation of up to 60 seconds');
	}
}

/** Validate uploaded formats by decoding or probing trusted local temporary bytes. */
export async function storeGraphicsAsset(root: string, filename: string, data: Buffer, ffprobe: string): Promise<GraphicsAsset> {
	const extension = path.extname(filename).toLowerCase().slice(1);
	const id = randomUUID();
	const name = Array.from(path.basename(filename)).filter(character => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127).join('').slice(0, 120) || 'Graphics asset';
	if (!data.length || data.length > GRAPHICS_UPLOAD_LIMIT) {
		throw new Error('Upload must contain up to 32 MiB');
	}

	const animationFrames = extension === 'png' || extension === 'apng' ? pngAnimationFrames(data) : undefined;
	const format = animationFrames !== undefined ? 'apng' : extension === 'jpg' ? 'jpeg' : extension;
	if (format === 'apng') {
		const metadata = await sharp(data, { limitInputPixels: 24_000_000 }).metadata();
		const { width = 0, height = 0 } = metadata;
		if (metadata.format !== 'png' || !animationFrames || animationFrames > 240
			|| !width || width > 3840 || !height || height > 2160 || width * height * animationFrames > 24_000_000) {
			throw new Error('Unsupported APNG dimensions or frame count');
		}
		const temporary = path.join(root, 'assets', `${id}.upload`);
		try {
			await publishGraphicsFile(temporary, data);
			await validateApng(temporary, animationFrames, ffprobe);
			await rename(temporary, path.join(root, 'assets', `${id}.apng`));
			return { id, name, format, kind: 'image', protected: false };
		}
		finally {
			await rm(temporary, { force: true });
		}
	}

	if (format === 'png' || format === 'jpeg' || format === 'gif' || format === 'webp') {
		const decoder = sharp(data, { animated: true, limitInputPixels: 24_000_000 });
		const metadata = await decoder.metadata();
		if (metadata.format !== format || !metadata.width || metadata.width > 3840
			|| (metadata.pageHeight ?? metadata.height ?? Infinity) > 2160 || (metadata.pages ?? 1) > 240 || (format === 'webp' && (metadata.pages ?? 1) > 1)) {
			throw new Error('Unsupported image format, dimensions, or frame count. Use GIF or APNG for animated overlays.');
		}
		await decoder.timeout({ seconds: 3 }).stats();
		const asset = { id, name, format, kind: 'image', protected: false } as const;
		await publishGraphicsFile(path.join(root, 'assets', `${id}.${format}`), data);
		return asset;
	}

	if (format !== 'ttf' && format !== 'otf' && format !== 'mp4' && format !== 'webm') {
		throw new Error('Use PNG, APNG, JPEG, GIF, WebP, MP4, WebM, TTF, or OTF');
	}
	const kind = format === 'ttf' || format === 'otf' ? 'font' : 'video';
	const destination = path.join(root, 'assets', `${id}.${format}`);
	const temporary = path.join(root, 'assets', `${id}.upload`);
	try {
		await publishGraphicsFile(temporary, data);
		if (kind === 'font') {
			if (format === 'ttf' ? data.subarray(0, 4).toString('hex') !== '00010000' : data.subarray(0, 4).toString('hex') !== '4f54544f') {
				throw new Error('Invalid or oversized font');
			}
			graphicsFontFamily(data);
			const { stdout: coverage } = await runGraphicsProcess('fc-scan', [
				'--format', '%{charset}', temporary,
			], { timeout: 3_000, maxBuffer: 128 * 1024 });
			if (!coverage.trim()) {
				throw new Error('The graphics font has no usable character map');
			}
		}
		else {
			const { stdout } = await runGraphicsProcess(ffprobe, [
				'-v', 'error', '-protocol_whitelist', 'file', '-f', format === 'mp4' ? 'mov' : 'matroska',
				'-show_format', '-show_streams', '-of', 'json', temporary,
			], { timeout: 5000, maxBuffer: 128 * 1024 });
			const probe = JSON.parse(stdout);
			const video = probe.streams?.find((stream: { codec_type: string }) => stream.codec_type === 'video');
			const duration = Number(probe.format?.duration);
			if (!video || !['h264', 'hevc', 'vp8', 'vp9', 'av1'].includes(video.codec_name)
				|| video.width < 1 || video.width > 3840 || video.height < 1 || video.height > 2160
				|| !Number.isFinite(duration) || duration <= 0 || duration > 60) {
				throw new Error('Use a supported video codec at up to 3840 × 2160 and 60 seconds');
			}
			const ffmpeg = await graphicsDecoder(ffprobe);
			const { stdout: progress } = await runGraphicsProcess(ffmpeg, [
				'-v', 'error', '-nostdin', '-xerror', '-progress', 'pipe:1', '-protocol_whitelist', 'file',
				'-err_detect', 'explode', '-threads', '2', '-f', format === 'mp4' ? 'mov' : 'matroska',
				'-i', temporary, '-map', '0:v:0', '-an', '-sn', '-dn', '-f', 'null', '-',
			], { timeout: 15_000, maxBuffer: 128 * 1024 });
			if (!/^frame=\s*[1-9]\d*\s*$/m.test(progress)) {
				throw new Error('The graphics video contains no decodable frames');
			}
		}
		await rename(temporary, destination);
		return { id, name, kind, format, protected: false };
	}
	finally {
		await rm(temporary, { force: true });
	}
}
