import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import type { MediaSubtitleTrack } from '@moirai/shared';
import { decodeMediaText, MAX_SUBTITLE_TEXT_BYTES } from '../media/media-text.js';
import { openSourceFile, type OpenedSourceFile } from '../media/source-file.js';
import { probeSidecarStreams } from './sidecar-streams.js';
import { isImageSubtitle } from './subtitle-selection.js';

/** Publish immutable per-channel snapshots while retaining source descriptors through copying. */
export class SubtitleSnapshotStore {
	constructor(private readonly root: string) {}

	/** Validate all pair members, then snapshot through their opened descriptors before publishing. */
	async sidecar(channelId: string, track: MediaSubtitleTrack, file: string, root: string | undefined, ffprobePath: string): Promise<string> {
		if (!root) {
			throw new Error('Selected subtitle library root is unavailable');
		}
		const files = track.format === 'vobsub'
			? [file, track.playbackPaths.find((entry) => entry.toLowerCase().endsWith('.sub'))]
			: [file];
		const sources: OpenedSourceFile[] = [];
		try {
			// Open every member before copying any bytes, retaining ownership through publication.
			for (const source of files) {
				if (!source) {
					throw new Error('Selected VobSub pair is incomplete');
				}
				sources.push(await openSourceFile(root, source));
			}
			const key = JSON.stringify({ sidecarVersion: 3, sidecar: sources.map((source) => ({
				path: source.path, size: source.stat.size, modified: source.stat.mtimeMs,
			})) });
			const snapshots = [];
			for (const source of sources) {
				snapshots.push(await this.asset(channelId, key, path.extname(source.path).toLowerCase(), async (destination) => {
					const knownText = ['srt', 'ass', 'ssa', 'vtt'].includes(track.format ?? '');
					if (knownText && source.stat.size > MAX_SUBTITLE_TEXT_BYTES) {
						throw new Error('Text subtitle exceeds the 16 MiB normalization limit');
					}
					await pipeline(source.handle.createReadStream({ autoClose: false, ...(knownText ? { end: MAX_SUBTITLE_TEXT_BYTES } : {}) }), createWriteStream(destination, { flags: 'wx' }));
					if (track.format === 'vobsub' || track.format === 'sup') {
						return;
					}
					if (track.format === 'sub') {
						// Some text demuxers cannot recognize UTF-16 until it has been normalized.
						const streams = await probeSidecarStreams(destination, track, ffprobePath).catch(() => null);
						if (streams && streams.length !== 1) {
							throw new Error('Selected sidecar has no unambiguous subtitle stream');
						}
						if (streams && isImageSubtitle(streams[0]!)) {
							return;
						}
					}
					if ((await stat(destination)).size > MAX_SUBTITLE_TEXT_BYTES) {
						throw new Error('Text subtitle exceeds the 16 MiB normalization limit');
					}
					const normalized = decodeMediaText(await readFile(destination));
					await writeFile(destination, normalized, 'utf8');
				}));
			}
			return snapshots[0]!;
		}
		finally {
			await Promise.all(sources.map((source) => source.handle.close()));
		}
	}

	/** Atomically publish content-addressed assets, reusing existing complete files. */
	async asset(channelId: string, key: string, extension: string, create: (file: string) => Promise<void>): Promise<string> {
		const directory = path.join(this.root, channelId, 'subtitles');
		await mkdir(directory, { recursive: true });
		const destination = path.join(directory, createHash('sha256').update(key).digest('hex') + extension);
		try {
			await stat(destination);
			return destination;
		}
		catch {
			// Only complete files are visible at their permanent content address.
		}
		const temporary = destination + '.' + randomUUID();
		try {
			await create(temporary);
			await rename(temporary, destination);
		}
		finally {
			await rm(temporary, { force: true });
		}
		return destination;
	}
}
