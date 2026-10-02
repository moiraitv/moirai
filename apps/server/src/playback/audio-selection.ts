import { z } from 'zod';
import type { AudioPreferences, Channel, ScheduleGuide, SchedulingProgram, TimelineSegment } from '@moirai/shared';
import type { Repository } from '../repository/index.js';
import { primaryVideoStream } from '../media/video-stream.js';
import { subtitleLanguageKey } from './subtitle-selection.js';

/** Validated indexed audio facts; old scans can omit channel counts. */
const audioStreamSchema = z.object({
	type: z.literal('audio'),
	index: z.number().int().nonnegative(),
	language: z.string().nullable().optional(),
	title: z.string().nullable().optional(),
	titleAliases: z.array(z.string()).optional(),
	isCommentary: z.boolean().optional(),
	isAudioDescription: z.boolean().optional(),
	isDefault: z.boolean().optional(),
	channels: z.number().int().positive().nullable().optional(),
});

/** Audio selections and explicit video indexes share one batched metadata read. */
export type PreparedAudio = Map<string, Array<number | null>>;

/** Explicit maps survive structured cloning into the playout worker. */
export interface PreparedMediaStreams {
	audio: PreparedAudio;
	video: PreparedAudio;
}

/** Validate the cached facts needed to override the worker's video selection. */
const videoStreamSchema = z.object({
	type: z.literal('video'),
	index: z.number().int().nonnegative(),
	isAttachedPicture: z.boolean().optional(),
});

/** Select the same real video used by the probe without trusting cached metadata shapes. */
export function selectVideo(metadata: unknown): number | null {
	const parsed = z.object({ streams: z.array(z.unknown()) }).safeParse(metadata);
	if (!parsed.success) {
		return null;
	}
	const streams = parsed.data.streams.flatMap(stream => {
		const video = videoStreamSchema.safeParse(stream);
		return video.success ? [video.data] : [];
	});
	return primaryVideoStream(streams)?.index ?? null;
}

/** Resolve each field from channel through the captured outer-to-inner program path. */
export function audioPreferences(channel: Channel, segment: TimelineSegment, programs: ReadonlyMap<string, AudioPreferences>): AudioPreferences {
	let result = { ...channel.audioPreferences };
	for (const id of segment.programAncestry?.length ? segment.programAncestry : segment.programId ? [segment.programId] : []) {
		result = { ...result, ...programs.get(id) };
	}
	return result;
}

/** Honor language and alternate names, preferring main audio when a requested title is unavailable. */
export function selectAudio(metadata: unknown, preferences: AudioPreferences): number | null {
	if ((!preferences.language && !preferences.title) || !metadata || typeof metadata !== 'object') {
		return null;
	}
	const streams = (metadata as { streams?: unknown }).streams;
	if (!Array.isArray(streams)) {
		return null;
	}
	let candidates = streams.flatMap((stream) => {
		const parsed = audioStreamSchema.safeParse(stream);
		return parsed.success ? [parsed.data] : [];
	});
	if (preferences.language) {
		const language = subtitleLanguageKey(preferences.language);
		const matching = candidates.filter((stream) => stream.language && subtitleLanguageKey(stream.language) === language);
		if (matching.length) {
			candidates = matching;
		}
	}
	let matchedTitle = false;
	if (preferences.title) {
		const title = preferences.title.trim().toLowerCase();
		const matching = candidates.filter((stream) => [stream.title, ...(stream.titleAliases ?? [])]
			.some(value => value?.toLowerCase().includes(title)));
		if (matching.length) {
			candidates = matching;
			matchedTitle = true;
		}
	}
	if (!matchedTitle) {
		const main = candidates.filter(stream => !stream.isCommentary && !stream.isAudioDescription);
		if (main.length) {
			candidates = main;
		}
	}
	candidates.sort((left, right) => Number(Boolean(right.isDefault)) - Number(Boolean(left.isDefault))
		|| (right.channels ?? 0) - (left.channels ?? 0) || left.index - right.index);
	return candidates[0]?.index ?? null;
}

/** Select indexed streams in bounded batches, preserving worker defaults if preparation fails. */
export async function prepareMediaStreams(repository: Repository, channel: Channel, guide: ScheduleGuide, programs: SchedulingProgram[]): Promise<PreparedMediaStreams> {
	const result: PreparedMediaStreams = { audio: new Map(), video: new Map() };
	const preferences = new Map(programs.map((program) => [program.id, program.config.audioPreferences ?? {}]));
	const selected = guide.channels.flatMap((entry) => entry.preview.segments)
		.filter((segment) => segment.channelId === channel.id && segment.mediaItemId)
		.map((segment) => ({ segment, preference: audioPreferences(channel, segment, preferences) }));
	if (!selected.length) {
		return result;
	}
	try {
		const metadata = await repository.audioMetadata(selected.map(({ segment }) => segment.mediaItemId!));
		const videoByPath = new Map<string, number | null>();
		const audioByPath = new Map<string, number | null>();
		for (const { segment, preference } of selected) {
			const paths = segment.playbackParts?.length ? segment.playbackParts.map((part) => part.playbackPath) : [segment.playbackPath];
			result.audio.set(segment.id, paths.map(file => {
				if (!file) {
					return null;
				}
				const key = JSON.stringify([file, preference.language ?? null, preference.title ?? null]);
				if (!audioByPath.has(key)) {
					audioByPath.set(key, selectAudio(metadata.get(file), preference));
				}
				return audioByPath.get(key)!;
			}));
			result.video.set(segment.id, paths.map(file => {
				if (!file) {
					return null;
				}
				if (!videoByPath.has(file)) {
					videoByPath.set(file, selectVideo(metadata.get(file)));
				}
				return videoByPath.get(file)!;
			}));
		}
	}
	catch {
		// Optional preferences must not prevent publication of playable media.
		return result;
	}
	return result;
}

/** Preserve audio-only callers while sharing the same stream preparation implementation. */
export async function prepareAudio(repository: Repository, channel: Channel, guide: ScheduleGuide, programs: SchedulingProgram[]): Promise<PreparedAudio> {
	return (await prepareMediaStreams(repository, channel, guide, programs)).audio;
}
