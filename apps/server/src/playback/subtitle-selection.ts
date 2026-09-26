import { iso6393 } from 'iso-639-3';
import type { MediaSubtitleTrack, SubtitlePreferences } from '@moirai/shared';

/** Canonical language keys include bibliographic, terminological, and two-letter aliases. */
const languageKeys = new Map(iso6393.flatMap((language) =>
	[language.iso6393, language.iso6391, language.iso6392B, language.iso6392T]
		.filter((code): code is string => Boolean(code))
		.map((code) => [code, language.iso6393] as const)));

/** Normalize provider language tags without discarding their stored spelling. */
export function subtitleLanguageKey(value: string): string {
	const code = value.trim().toLowerCase().split(/[-_]/)[0]!;
	return languageKeys.get(code) ?? code;
}

/** Rank eligible tracks without relaxing language, policy, or physical-part constraints. */
export function subtitleCandidates(
	tracks: MediaSubtitleTrack[],
	preferences: SubtitlePreferences,
	partNumber: number,
): MediaSubtitleTrack[] {
	if (!preferences.policy || preferences.policy === 'off') {
		return [];
	}

	const candidates = tracks.filter((track) =>
		(track.partNumber === null || track.partNumber === partNumber)
		&& (!preferences.language || (track.language !== null
			&& subtitleLanguageKey(track.language) === subtitleLanguageKey(preferences.language)))
		&& (preferences.policy !== 'forced' || track.isForced));
	candidates.sort((left, right) => {
		const defaultOrder = preferences.policy === 'default'
			? Number(right.isDefault) - Number(left.isDefault) : 0;
		return defaultOrder
			|| Number(right.partNumber !== null) - Number(left.partNumber !== null)
			|| Number(right.sourceType === 'embedded') - Number(left.sourceType === 'embedded')
			|| (left.streamIndex ?? 0) - (right.streamIndex ?? 0)
			|| left.relativePaths.join('/').localeCompare(right.relativePaths.join('/'), 'en')
			|| left.id.localeCompare(right.id, 'en');
	});
	const seen = new Set<string>();
	return candidates.filter(track => {
		const key = JSON.stringify([track.sourceType, track.partNumber, track.streamIndex, track.playbackPaths]);
		if (seen.has(key)) {
			return false;
		}
		seen.add(key);
		return true;
	});
}

/** Keep single-selection callers compatible with the ordered candidate list. */
export function selectSubtitle(tracks: MediaSubtitleTrack[], preferences: SubtitlePreferences, partNumber: number): MediaSubtitleTrack | null {
	return subtitleCandidates(tracks, preferences, partNumber)[0] ?? null;
}

/** Maximum distinct subtitle preparations attempted for one physical part. */
export const MAX_SUBTITLE_PREPARATION_ATTEMPTS = 3;

/** Image codecs stay in the engine's overlay path even when text is converted to WebVTT. */
export function isImageSubtitle(track: MediaSubtitleTrack): boolean {
	return ['hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle', 'xsub'].includes(track.codec ?? '')
		|| ['vobsub', 'sup'].includes(track.format ?? '');
}
