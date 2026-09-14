/** Fold music labels consistently in SQLite and scheduling without removing accents. */
export function foldMusicSearchText(value: string): string {
	return value.toLowerCase();
}

/** Match a literal portion of an artist or album name using Unicode case folding. */
export function musicTextMatches(value: string, search: string): boolean {
	return foldMusicSearchText(value).includes(foldMusicSearchText(search));
}
