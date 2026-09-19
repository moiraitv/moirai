import { canonicalIdentityKey } from '@moirai/shared';
import type { DiscoveredGroup, DiscoveredItem } from '../repository/contracts.js';
import { catalogSortTitle } from './catalog-metadata.js';
import { deterministicId } from './catalog-identity.js';

/** Add missing artist and album levels without changing existing folder-group or song identities. */
export function groupLooseMusicVideos(
	libraryId: string,
	groups: Map<string, DiscoveredGroup>,
	items: DiscoveredItem[],
): void {
	// Reuse existing groups by display identity; preserve their folder-based stable keys.
	const artists = new Map<string | null, DiscoveredGroup>();
	const albums = new Map<string, DiscoveredGroup>();
	for (const group of [...groups.values()].sort((left, right) => left.stableKey.localeCompare(right.stableKey))) {
		const key = canonicalIdentityKey(group.title);
		if (group.kind === 'artist' && !artists.has(key)) {
			artists.set(key, group);
		}
		else if (group.kind === 'album') {
			const albumKey = JSON.stringify([group.parentId, key]);
			if (!albums.has(albumKey)) {
				albums.set(albumKey, group);
			}
		}
	}

	// Stable file order keeps preferred spelling independent of concurrent probe completion.
	for (const item of [...items].sort((left, right) => left.relativePath.localeCompare(right.relativePath))) {
		if (item.groupId) {
			continue;
		}

		const artistTitle = item.artists.find(artist => artist.trim())?.trim();
		const artistKey = artistTitle ? canonicalIdentityKey(artistTitle) : null;
		let artist = artists.get(artistKey);
		if (!artist) {
			artist = metadataGroup(libraryId, `music-artist:${JSON.stringify(artistKey)}`, 'artist', artistTitle ?? 'Unknown artist', null);
			artists.set(artistKey, artist);
			groups.set(artist.stableKey, artist);
		}

		const albumTitle = typeof item.metadata.album === 'string' ? item.metadata.album.trim() : '';
		const albumKey = JSON.stringify([artist.id, albumTitle ? canonicalIdentityKey(albumTitle) : null]);
		let album = albums.get(albumKey);
		if (!album) {
			album = metadataGroup(libraryId, `music-album:${albumKey}`, 'album', albumTitle || 'Unknown album', artist.id);
			albums.set(albumKey, album);
			groups.set(album.stableKey, album);
		}
		item.groupId = album.id;
	}
}

/** Construct a metadata-owned group without treating metadata names as filesystem paths. */
function metadataGroup(
	libraryId: string,
	key: string,
	kind: 'artist' | 'album',
	title: string,
	parentId: string | null,
): DiscoveredGroup {
	return {
		id: deterministicId(libraryId, key),
		stableKey: key,
		sourceKey: key,
		parentId,
		kind,
		title,
		sortTitle: catalogSortTitle(title),
		year: null,
		plot: null,
		metadata: {},
		artworkRelativePath: null,
		posterRelativePath: null,
		landscapeRelativePath: null,
		fanartRelativePath: null,
	};
}
