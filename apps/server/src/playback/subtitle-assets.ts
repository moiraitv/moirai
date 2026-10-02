import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stat, writeFile } from 'node:fs/promises';
import type { Channel, MediaSubtitleTrack, ScheduleGuide, SubtitlePreferences, TimelineSegment } from '@moirai/shared';
import type { EtvSubtitleSelection } from '@moirai/ersatztv-contract';
import type { Repository } from '../repository/index.js';
import { probeSidecarStreams } from './sidecar-streams.js';
import { creditContext } from './credit-context.js';
import { renderCreditTemplate } from './credit-renderer.js';
import { isImageSubtitle, subtitleCandidates, MAX_SUBTITLE_PREPARATION_ATTEMPTS } from './subtitle-selection.js';

import { SubtitleSnapshotStore } from './subtitle-snapshots.js';

/** Only inherited subtitle fields are needed for main-thread asset preparation. */
export interface SubtitleProgram {
	id: string;
	config: { subtitlePreferences?: SubtitlePreferences | undefined };
}

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
	private readonly snapshots: SubtitleSnapshotStore;
	constructor(root: string, private readonly repository: Repository) {
		this.snapshots = new SubtitleSnapshotStore(root);
	}

	/** Resolve inherited preferences against the program path captured by materialization. */
	preferences(channel: Channel, segment: TimelineSegment, programs: Map<string, SubtitlePreferences>): SubtitlePreferences {
		let result = { ...channel.subtitlePreferences };
		for (const id of segment.programAncestry?.length ? segment.programAncestry : segment.programId ? [segment.programId] : []) {
			result = { ...result, ...programs.get(id) };
		}
		return result;
	}

	/** Prepare all referenced selections in bounded metadata batches, isolating per-item failures. */
	async prepare(channel: Channel, guide: ScheduleGuide, programs?: Promise<SubtitleProgram[]>): Promise<PreparedSubtitles> {
		try {
			return await this.prepareSelections(channel, guide, programs);
		}
		catch {
			this.issues.set(channel.id, ['Unable to prepare optional subtitles; playback will continue without them']);
			return new Map();
		}
	}

	/** Resolve metadata and prepare selections, omitting individual failed subtitles. */
	private async prepareSelections(channel: Channel, guide: ScheduleGuide, suppliedPrograms?: Promise<SubtitleProgram[]>): Promise<PreparedSubtitles> {
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
		const prepared = new Map<string, Promise<EtvSubtitleSelection | null>>();
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
						const file = await this.snapshots.asset(channel.id, key, '.ass', async (destination) => {
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
									streams = this.snapshots.sidecar(channel.id, candidate, file, roots.get(item.libraryId), channel.ffprobePath ?? 'ffprobe').then((snapshot) => probeSidecarStreams(snapshot, { ...candidate, playbackPaths: [snapshot] }, channel.ffprobePath ?? 'ffprobe')).catch(() => {
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
						const candidates = subtitleCandidates(tracks, preferences, physicalPart?.number ?? 1);
						let choice: EtvSubtitleSelection | null = null;
						for (const track of candidates.slice(0, MAX_SUBTITLE_PREPARATION_ATTEMPTS)) {
							const key = JSON.stringify([track.sourceType, track.streamIndex, track.playbackPaths, part.playbackPath, channel.subtitleMode, roots.get(item.libraryId)]);
							try {
								let preparation = prepared.get(key);
								if (!preparation) {
									preparation = this.prepareTrack(channel, track, part.playbackPath, roots.get(item.libraryId));
									prepared.set(key, preparation);
								}
								choice = await preparation;
								if (choice) {
									if (track.sourceType === 'sidecar') {
										choice = { ...choice, offsetMs: track.partNumber === null ? partStartMs : 0 };
									}
									break;
								}
							}
							catch (cause) {
								const message = cause instanceof Error && !('cmd' in cause) ? cause.message : 'Unable to prepare the selected subtitle';
								issues.add(`${item.title}: ${message}`);
							}
						}
						choices.push(choice);
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

	/** Prepare one candidate without timing offsets so repeated segments reuse successes and failures. */
	private async prepareTrack(channel: Channel, track: MediaSubtitleTrack, playbackPath: string, root: string | undefined): Promise<EtvSubtitleSelection | null> {
		if (track.sourceType === 'sidecar') {
			let file = track.format === 'vobsub' ? track.playbackPaths.find(file => file.toLowerCase().endsWith('.idx')) : track.playbackPaths[0];
			if (!file) {
				throw new Error('Selected subtitle has no playback path');
			}
			await stat(file);
			if (track.format !== 'vobsub') {
				file = await this.snapshots.sidecar(channel.id, track, file, root, channel.ffprobePath ?? 'ffprobe');
				const streams = await probeSidecarStreams(file, track, channel.ffprobePath ?? 'ffprobe');
				if (track.streamIndex === null ? streams.length !== 1 : !streams.some(stream => stream.streamIndex === track.streamIndex)) {
					throw new Error('Selected sidecar has no unambiguous subtitle stream');
				}
			}
			return { path: file, ...(track.streamIndex === null ? {} : { streamIndex: track.streamIndex }) };
		}
		if (channel.subtitleMode === 'burn' && !isImageSubtitle(track)) {
			const source = await stat(playbackPath);
			const key = JSON.stringify({ path: playbackPath, size: source.size, modified: source.mtimeMs, stream: track.streamIndex });
			const file = await this.snapshots.asset(channel.id, key, '.ass', async destination => {
				await execute(channel.ffmpegPath ?? 'ffmpeg', ['-nostdin', '-v', 'error', '-y', '-i', playbackPath, '-map', `0:${track.streamIndex}`, '-c:s', 'ass', '-f', 'ass', destination], { timeout: 120_000, maxBuffer: 1_048_576 });
			});
			return { path: file };
		}
		return track.streamIndex === null ? null : { streamIndex: track.streamIndex };
	}
}
