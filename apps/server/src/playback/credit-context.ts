import type { Channel, MediaItem } from '@moirai/shared';

/** Read string metadata lists while excluding provider-specific objects. */
function names(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

/** Expose only documented plain metadata values to authored templates. */
export function creditContext(item: MediaItem, channel: Channel): Record<string, unknown> {
	const date = item.releaseDate;
	return {
		resolution: { width: channel.video.width ?? 1920, height: channel.video.height ?? 1080 },
		title: item.title,
		artist: item.artists[0] ?? '',
		all_artists: item.artists,
		album: typeof item.metadata.album === 'string' ? item.metadata.album : '',
		track: item.trackNumber,
		plot: item.plot ?? '',
		release_date: date ? { year: Number(date.slice(0, 4)), date } : item.year ? { year: item.year, date: null } : null,
		studios: names(item.metadata.studio),
		directors: names(item.metadata.directors),
		duration: { total_seconds: item.durationSeconds ?? 0 },
	};
}
