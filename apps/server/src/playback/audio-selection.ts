import { z } from 'zod';
import type { AudioPreferences, Channel, ScheduleGuide, SchedulingProgram, TimelineSegment } from '@moirai/shared';
import type { Repository } from '../repository/index.js';
import { subtitleLanguageKey } from './subtitle-selection.js';

/** Validated indexed audio facts; old scans can omit channel counts. */
const audioStreamSchema = z.object({
	type: z.literal('audio'),
	index: z.number().int().nonnegative(),
	language: z.string().nullable().optional(),
	title: z.string().nullable().optional(),
	isDefault: z.boolean().optional(),
	channels: z.number().int().positive().nullable().optional(),
});

/** One optional stream index per physical part of each scheduled segment. */
export type PreparedAudio = Map<string, Array<number | null>>;

/** Resolve each field from channel through the captured outer-to-inner program path. */
export function audioPreferences(channel: Channel, segment: TimelineSegment, programs: ReadonlyMap<string, AudioPreferences>): AudioPreferences {
	let result = { ...channel.audioPreferences };
	for (const id of segment.programAncestry?.length ? segment.programAncestry : segment.programId ? [segment.programId] : []) {
		result = { ...result, ...programs.get(id) };
	}
	return result;
}

/** Prefer language, title, default disposition, and channel count without removing audio. */
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
	if (preferences.title) {
		const title = preferences.title.trim().toLowerCase();
		const matching = candidates.filter((stream) => stream.title?.toLowerCase().includes(title));
		if (matching.length) {
			candidates = matching;
		}
	}
	candidates.sort((left, right) => Number(Boolean(right.isDefault)) - Number(Boolean(left.isDefault))
		|| (right.channels ?? 0) - (left.channels ?? 0) || left.index - right.index);
	return candidates[0]?.index ?? null;
}

/** Select indexed streams in bounded batches, preserving worker defaults if preparation fails. */
export async function prepareAudio(repository: Repository, channel: Channel, guide: ScheduleGuide, programs: SchedulingProgram[]): Promise<PreparedAudio> {
	const result: PreparedAudio = new Map();
	const preferences = new Map(programs.map((program) => [program.id, program.config.audioPreferences ?? {}]));
	const selected = guide.channels.flatMap((entry) => entry.preview.segments)
		.filter((segment) => segment.channelId === channel.id && segment.mediaItemId)
		.map((segment) => ({ segment, preference: audioPreferences(channel, segment, preferences) }))
		.filter(({ preference }) => preference.language || preference.title);
	if (!selected.length) {
		return result;
	}
	try {
		const metadata = await repository.audioMetadata(selected.map(({ segment }) => segment.mediaItemId!));
		for (const { segment, preference } of selected) {
			const paths = segment.playbackParts?.length ? segment.playbackParts.map((part) => part.playbackPath) : [segment.playbackPath];
			result.set(segment.id, paths.map((file) => file ? selectAudio(metadata.get(file), preference) : null));
		}
	}
	catch {
		// Optional preferences must not prevent publication of playable media.
		return new Map();
	}
	return result;
}
