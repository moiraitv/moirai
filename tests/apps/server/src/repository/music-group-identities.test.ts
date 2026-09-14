import { expect, it } from 'vitest';
import { preserveMusicGroupIdentities } from '@server/repository/music-group-identities.js';
import type { DiscoveredGroup } from '@server/repository/contracts.js';

function group(id: string, overrides: Partial<DiscoveredGroup> = {}): DiscoveredGroup {
	return { id, stableKey: id, sourceKey: id, kind: 'artist', parentId: null,
		title: 'Artist', sortTitle: 'artist', year: null, plot: null, metadata: {}, artworkRelativePath: null, ...overrides };
}

function stored(value: DiscoveredGroup): Parameters<typeof preserveMusicGroupIdentities>[2][number] {
	return { ...value, sourceKey: value.sourceKey ?? value.stableKey, libraryId: 'library', createdAt: '', updatedAt: '' };
}

it('retains first-match precedence between source-key and ID owners and claims each only once', () => {
	const existing = [stored(group('first', { sourceKey: 'shared' })), stored(group('second'))];
	const discovered = [group('second', { sourceKey: 'shared' }), group('third', { sourceKey: 'shared' })];
	preserveMusicGroupIdentities(discovered, [], existing);
	expect(discovered.map(value => value.id)).toEqual(['first', 'third']);
});

it('keeps ambiguous fallbacks unresolved and removes claimed owners from fallback buckets', () => {
	const existing = [stored(group('music:first')), stored(group('music:second'))];
	const discovered = [group('ambiguous'), group('exact', { sourceKey: 'music:first' }), group('remaining')];
	// Metadata-owned keys use the scanner music- prefix.
	for (const value of existing) {
		value.stableKey = value.stableKey.replace('music:', 'music-');
	}
	preserveMusicGroupIdentities(discovered, [], existing);
	expect(discovered.map(value => value.id)).toEqual(['ambiguous', 'music:first', 'music:second']);
});

it('respects parent ownership, metadata eligibility, and IDs reserved by discovered groups', () => {
	const existing = [
		stored(group('reserved', { stableKey: 'music-reserved' })),
		stored(group('folder', { title: 'Other' })),
		stored(group('album', { kind: 'album', parentId: 'parent', title: 'Album', stableKey: 'music-album' })),
	];
	const discovered = [group('new'), group('reserved'), group('another', { title: 'Other' }),
		group('new-album', { kind: 'album', parentId: 'different', title: 'Album' })];
	preserveMusicGroupIdentities(discovered, [], existing);
	expect(discovered.map(value => value.id)).toEqual(['new', 'reserved', 'another', 'new-album']);
});

it('preserves all IDs in a large unchanged artist and album catalog', () => {
	const groups = Array.from({ length: 20_000 }, (_, index) => group(String(index), {
		kind: index % 2 ? 'album' : 'artist', parentId: index % 2 ? String(index - 1) : null,
	}));
	const ids = groups.map(value => value.id);
	preserveMusicGroupIdentities(groups, [], groups.map(stored));
	expect(groups.map(value => value.id)).toEqual(ids);
});
