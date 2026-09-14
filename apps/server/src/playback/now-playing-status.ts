import type { PlaybackNowPlayingStatus } from '@moirai/shared';
import type { MaterializedSegmentRecord } from '../repository/contracts.js';

/** Format committed programming with the content identity viewers need on the Status page. */
export function nowPlayingStatus(record: MaterializedSegmentRecord | undefined): PlaybackNowPlayingStatus | null {
	if (!record) {
		return null;
	}

	const media = record.mediaSnapshot;
	let title = record.segment.title;
	if (media?.kind === 'episode') {
		const season = media.seasonNumber == null ? '' : `S${media.seasonNumber}`;
		const episode = media.episodeNumber == null ? '' : `E${media.episodeNumber}`;
		const end = media.episodeEndNumber != null && media.episodeNumber != null && media.episodeEndNumber > media.episodeNumber
			? `–E${media.episodeEndNumber}` : '';
		title = [media.seriesTitle?.trim(), `${season}${episode}${end}`, media.title || title].filter(Boolean).join(' · ');
	}
	else if (media?.kind === 'music-video') {
		const artists = [...new Set((media.artists ?? []).map(artist => artist.trim()).filter(Boolean))];
		title = [artists.join(', '), media.title || title].filter(Boolean).join(' · ');
	}

	return {
		title,
		artworkUrl: media?.artworkUrl ?? null,
		startedAt: record.segment.start,
		finishesAt: record.segment.finish,
	};
}
