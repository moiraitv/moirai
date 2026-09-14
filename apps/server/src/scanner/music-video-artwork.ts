import type { DiscoveredGroup, DiscoveredItem } from '../repository/contracts.js';

/** Fill missing artist posters from the first album poster, then the first song poster. */
export function inheritMusicArtistArtwork(groups: DiscoveredGroup[], items: DiscoveredItem[]): void {
	const byId = new Map(groups.map(group => [group.id, group]));
	const candidates = new Map<string, DiscoveredGroup | DiscoveredItem>();

	// Stable source order avoids changing the selected poster with concurrent probe completion.
	for (const album of [...groups].sort((left, right) => left.stableKey.localeCompare(right.stableKey))) {
		if (album.kind === 'album' && album.parentId && album.artworkRelativePath && !candidates.has(album.parentId)) {
			candidates.set(album.parentId, album);
		}
	}
	for (const song of [...items].sort((left, right) => left.relativePath.localeCompare(right.relativePath))) {
		const parent = song.groupId ? byId.get(song.groupId) : undefined;
		const artistId = parent?.kind === 'artist' ? parent.id : parent?.parentId;
		if (artistId && song.artworkRelativePath && !candidates.has(artistId)) {
			candidates.set(artistId, song);
		}
	}

	// Reuse the source fingerprint so poster changes invalidate the artist artwork cache too.
	for (const artist of groups) {
		const source = candidates.get(artist.id);
		if (artist.kind !== 'artist' || artist.artworkRelativePath || !source) {
			continue;
		}
		artist.artworkRelativePath = source.artworkRelativePath;
		artist.metadata = { ...artist.metadata, artworkFingerprint: source.metadata.artworkFingerprint ?? source.artworkRelativePath };
	}
}
