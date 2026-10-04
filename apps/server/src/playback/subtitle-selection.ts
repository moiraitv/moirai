import { iso6393 } from 'iso-639-3';
import type { MediaSubtitleTrack, SubtitlePreferences, SubtitleRejectionReason } from '@moirai/shared';

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

/** Rank eligible tracks without relaxing language, title, policy, or physical-part constraints. */
export function subtitleCandidates(
	tracks: MediaSubtitleTrack[],
	preferences: SubtitlePreferences,
	partNumber: number,
): MediaSubtitleTrack[] {
	if (!preferences.policy || preferences.policy === 'off') {
		return [];
	}

	const candidates = tracks.filter(track => !subtitleRejectionReasons(track, preferences, partNumber).length);
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
		const key = subtitleTrackKey(track);
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

/** Resolve fields independently, retaining explicit nulls and authored layer order. */
export function resolveSubtitlePreferences(base: SubtitlePreferences | undefined, layers: Array<SubtitlePreferences | undefined>): SubtitlePreferences {
	return Object.assign({}, base, ...layers);
}

/** Identify physical subtitle candidates consistently across selection and preview. */
export function subtitleTrackKey(track: MediaSubtitleTrack): string {
	return JSON.stringify([track.sourceType, track.partNumber, track.streamIndex, track.playbackPaths]);
}

/** Explain every failed constraint without guessing track contents from its title. */
export function subtitleRejectionReasons(track: MediaSubtitleTrack, preferences: SubtitlePreferences, partNumber: number): SubtitleRejectionReason[] {
	const reasons: SubtitleRejectionReason[] = [];
	if (!preferences.policy || preferences.policy === 'off') {
		reasons.push('off');
	}
	if (track.partNumber !== null && track.partNumber !== partNumber) {
		reasons.push('part');
	}
	if (preferences.language && (track.language === null || subtitleLanguageKey(track.language) !== subtitleLanguageKey(preferences.language))) {
		reasons.push('language');
	}
	if (preferences.title && !track.title?.toLowerCase().includes(preferences.title.trim().toLowerCase())) {
		reasons.push('title');
	}
	if (preferences.policy === 'forced' && !track.isForced) {
		reasons.push('forced');
	}
	return reasons;
}
