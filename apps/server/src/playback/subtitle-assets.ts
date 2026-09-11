import type { SchedulingProgram } from '@moirai/shared';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { openSourceFile, type OpenedSourceFile } from '../media/source-file.js';
import type { Channel, MediaSubtitleTrack, ScheduleGuide, SubtitlePreferences, TimelineSegment } from '@moirai/shared';
import type { EtvSubtitleSelection } from '@moirai/ersatztv-contract';
import type { Repository } from '../repository/index.js';
import { probeSidecarStreams } from './sidecar-streams.js';
import { creditContext } from './credit-context.js';
import { renderCreditTemplate } from './credit-renderer.js';
import { isImageSubtitle, selectSubtitle } from './subtitle-selection.js';

/** Invoke FFmpeg without a shell and with bounded execution/output. */
const execute = promisify(execFile);
/** Concrete selections indexed by segment and physical part. */
export type PreparedSubtitles = Map<string, Array<EtvSubtitleSelection | null>> & { subtitleMode?: Channel['subtitleMode'] };

/**
 * Prepare immutable subtitle assets before publishing playout. Assets live in per-channel folders;
 * obsolete files are collected only when no worker can retain an earlier playout document.
 */
export class SubtitleAssets {
	readonly issues = new Map<string, string[]>();
	constructor(private readonly root: string, private readonly repository: Repository) {}

	/** Resolve inherited preferences against the program path captured by materialization. */
	preferences(channel: Channel, segment: TimelineSegment, programs: Map<string, SubtitlePreferences>): SubtitlePreferences {
		let result = { ...channel.subtitlePreferences };
		for (const id of segment.programAncestry?.length ? segment.programAncestry : segment.programId ? [segment.programId] : []) {
			result = { ...result, ...programs.get(id) };
		}
		return result;
	}

	/** Prepare all referenced selections in bounded metadata batches, isolating per-item failures. */
	async prepare(channel: Channel, guide: ScheduleGuide, programs?: Promise<SchedulingProgram[]>): Promise<PreparedSubtitles> {
		try {
			return await this.prepareSelections(channel, guide, programs);
		}
		catch {
			this.issues.set(channel.id, ['Unable to prepare optional subtitles; playback will continue without them']);
			return new Map();
		}
	}

	/** Resolve metadata and prepare selections, omitting individual failed subtitles. */
	private async prepareSelections(channel: Channel, guide: ScheduleGuide, suppliedPrograms?: Promise<SchedulingProgram[]>): Promise<PreparedSubtitles> {
		const result: PreparedSubtitles = new Map();
		const programs = new Map((await (suppliedPrograms ?? this.repository.listPrograms())).map((program) => [program.id, program.config.subtitlePreferences ?? {}]));
		const segments = guide.channels.flatMap((entry) => entry.preview.segments)
			.filter((segment) => segment.channelId === channel.id && segment.mediaItemId);
		const selected = segments.filter((segment) => {
			const preferences = this.preferences(channel, segment, programs);
			return preferences.creditsTemplateId || (preferences.policy && preferences.policy !== 'off');
		});
		const subtitleMode = channel.subtitlePreferences?.creditsTemplateId || selected.some((segment) => this.preferences(channel, segment, programs).creditsTemplateId)
			? 'burn' : channel.subtitleMode;
		result.subtitleMode = subtitleMode;
		channel = { ...channel, subtitleMode };
		const issues = new Set<string>();
		const sidecarStreams = new Map<string, Promise<MediaSubtitleTrack[]>>();
		if (selected.length === 0) {
			this.issues.set(channel.id, []);
			return result;
		}

		const media = await this.repository.creditTemplates.media(selected.map((segment) => segment.mediaItemId!));
		const sidecarLibraries = selected.flatMap((segment) => {
			const item = media.get(segment.mediaItemId!);
			const preferences = this.preferences(channel, segment, programs);
			if (!item || !preferences.policy || preferences.policy === 'off' || (item.kind === 'music-video' && preferences.creditsTemplateId)) {
				return [];
			}
			return [...item.subtitleTracks, ...item.parts.flatMap((part) => part.subtitleTracks)]
				.some((track) => track.sourceType === 'sidecar') ? [item.libraryId] : [];
		});
		const roots = sidecarLibraries.length ? await this.repository.getLibraryPlaybackRoots(sidecarLibraries) : new Map<string, string>();

		const templates = new Map((await this.repository.creditTemplates.list()).map((template) => [template.id, template]));
		for (const segment of selected) {
			const item = media.get(segment.mediaItemId!);
			if (!item) {
				issues.add(`${segment.title}: subtitle metadata is unavailable`);
				continue;
			}
			const preferences = this.preferences(channel, segment, programs);
			const parts = segment.playbackParts?.length ? segment.playbackParts : [{ playbackPath: item.playbackPath, durationSeconds: item.durationSeconds ?? 0 }];
			const choices: Array<EtvSubtitleSelection | null> = [];
			let partStartMs = 0;
			for (const [index, part] of parts.entries()) {
				try {
					if (preferences.creditsTemplateId && item.kind === 'music-video') {
						const template = templates.get(preferences.creditsTemplateId);
						if (!template) {
							throw new Error('Selected credit template is missing');
						}
						const context = creditContext(item, channel);
						const key = JSON.stringify({ source: template.source, context });
						const file = await this.asset(channel.id, key, '.ass', async (destination) => {
							await writeFile(destination, await renderCreditTemplate(template.source, context));
						});
						choices.push({ path: file, offsetMs: partStartMs });
					}
					else {
						const physicalPart = item.parts[index];
						const tracks: MediaSubtitleTrack[] = [];
						for (const candidate of preferences.policy && preferences.policy !== 'off' ? [...item.subtitleTracks, ...item.parts.flatMap((value) => value.subtitleTracks)] : []) {
							if (candidate.partNumber !== null && candidate.partNumber !== (physicalPart?.number ?? 1)) {
								continue;
							}
							if (candidate.sourceType === 'sidecar' && candidate.format === 'vobsub') {
								const file = candidate.playbackPaths.find((file) => file.toLowerCase().endsWith('.idx'));
								if (!file) {
									continue;
								}
								let streams = sidecarStreams.get(candidate.id);
								if (!streams) {
									streams = this.sidecar(channel.id, candidate, file, roots.get(item.libraryId)).then((snapshot) => probeSidecarStreams(snapshot, { ...candidate, playbackPaths: [snapshot] }, channel.ffprobePath ?? 'ffprobe')).catch(() => {
										issues.add(`${item.title}: unable to read a VobSub sidecar; other subtitle tracks remain available`);
										return [];
									});
									sidecarStreams.set(candidate.id, streams);
								}
								tracks.push(...await streams);
							}
							else {
								tracks.push(candidate);
							}
						}
						const track = selectSubtitle(tracks, preferences, physicalPart?.number ?? 1);
						if (!track) {
							choices.push(null);
						}
						else if (track.sourceType === 'sidecar') {
							let file = track.format === 'vobsub' ? track.playbackPaths.find((file) => file.toLowerCase().endsWith('.idx')) : track.playbackPaths[0];
							if (!file) {
								throw new Error('Selected subtitle has no playback path');
							}
							await stat(file);
							if (track.format !== 'vobsub') {
								file = await this.sidecar(channel.id, track, file, roots.get(item.libraryId));
								let streams = sidecarStreams.get(track.id);
								if (!streams) {
									streams = probeSidecarStreams(file, track, channel.ffprobePath ?? 'ffprobe');
									sidecarStreams.set(track.id, streams);
								}
								const available = await streams;
								if (track.streamIndex === null ? available.length !== 1 : !available.some((stream) => stream.streamIndex === track.streamIndex)) {
									throw new Error('Selected sidecar has no unambiguous subtitle stream');
								}
							}
							choices.push({ path: file, ...(track.streamIndex === null ? {} : { streamIndex: track.streamIndex }), offsetMs: track.partNumber === null ? partStartMs : 0 });
						}
						else if (channel.subtitleMode === 'burn' && !isImageSubtitle(track)) {
							const source = await stat(part.playbackPath);
							const key = JSON.stringify({ path: part.playbackPath, size: source.size, modified: source.mtimeMs, stream: track.streamIndex });
							const file = await this.asset(channel.id, key, '.ass', async (destination) => {
								await execute(channel.ffmpegPath ?? 'ffmpeg', ['-nostdin', '-v', 'error', '-y', '-i', part.playbackPath, '-map', `0:${track.streamIndex}`, '-c:s', 'ass', '-f', 'ass', destination], { timeout: 120_000, maxBuffer: 1_048_576 });
							});
							choices.push({ path: file });
						}
						else {
							choices.push(track.streamIndex === null ? null : { streamIndex: track.streamIndex });
						}
					}
				}
				catch (cause) {
					choices.push(null);
					const message = cause instanceof Error && !('cmd' in cause) ? cause.message : 'Unable to prepare the selected subtitle';
					issues.add(`${item.title}: ${message}`);
				}
				partStartMs += Math.round(part.durationSeconds * 1_000);
			}
			result.set(segment.id, choices);
		}
		this.issues.set(channel.id, [...issues].slice(0, 100));
		return result;
	}

	/** Validate all pair members, then snapshot through their opened descriptors before publishing. */
	private async sidecar(channelId: string, track: MediaSubtitleTrack, file: string, root: string | undefined): Promise<string> {
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
			const key = JSON.stringify({ sidecarVersion: 2, sidecar: sources.map((source) => ({
				path: source.path, size: source.stat.size, modified: source.stat.mtimeMs,
				device: source.stat.dev, inode: source.stat.ino,
			})) });
			const snapshots = [];
			for (const source of sources) {
				snapshots.push(await this.asset(channelId, key, path.extname(source.path).toLowerCase(), async (destination) => {
					await pipeline(source.handle.createReadStream({ autoClose: false }), createWriteStream(destination, { flags: 'wx' }));
				}));
			}
			return snapshots[0]!;
		}
		finally {
			await Promise.all(sources.map((source) => source.handle.close()));
		}
	}

	/** Atomically publish content-addressed assets, reusing existing complete files. */
	private async asset(channelId: string, key: string, extension: string, create: (file: string) => Promise<void>): Promise<string> {
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
