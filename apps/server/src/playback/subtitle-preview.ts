import { subtitlePreviewTrackSchema, type MediaItem, type SubtitleSelectionPreview, type SubtitleSelectionPreviewResult } from '@moirai/shared';
import { resolveSubtitlePreferences, subtitleCandidates, subtitleRejectionReasons, subtitleTrackKey } from './subtitle-selection.js';

/** Inspect indexed tracks without opening files, preparing assets, or altering playback issues. */
export function previewSubtitleSelection(item: MediaItem, input: SubtitleSelectionPreview): SubtitleSelectionPreviewResult {
	const preferences = resolveSubtitlePreferences(input.channelPreferences, input.programPreferences);
	const tracks = [...item.subtitleTracks, ...item.parts.flatMap(part => part.subtitleTracks)];
	const credits = item.kind === 'music-video' && Boolean(preferences.creditsTemplateId);
	const numbers = item.parts.length ? item.parts.map(part => part.number) : [1];
	return {
		mediaItemId: item.id, title: item.title, preferences,
		limitations: tracks.some(track => track.format === 'vobsub')
			? ['VobSub sidecar streams are resolved during preparation; their selection may differ from this indexed inventory.'] : [],
		parts: numbers.map(number => {
			const eligible = subtitleCandidates(tracks, preferences, number);
			const ranks = new Map(eligible.map((track, index) => [subtitleTrackKey(track), index + 1]));
			const unique = new Map([...eligible, ...tracks].map(track => [subtitleTrackKey(track), track]));
			// Retain the exact eligible record when duplicate provider records disagree.
			for (const track of eligible) {
				unique.set(subtitleTrackKey(track), track);
			}
			const off = !preferences.policy || preferences.policy === 'off';
			return {
				number, outcome: credits ? 'credits' : off ? 'off' : eligible.length ? 'selected' : 'no-match',
				selectedTrackId: credits || off ? null : eligible[0]?.id ?? null,
				tracks: [...unique.values()].map(track => ({
					track: subtitlePreviewTrackSchema.parse(track), rank: ranks.get(subtitleTrackKey(track)) ?? null,
					rejectionReasons: subtitleRejectionReasons(track, preferences, number),
				})),
			};
		}),
	};
}
