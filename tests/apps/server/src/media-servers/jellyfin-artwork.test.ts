import { describe, expect, it } from 'vitest';
import { JellyfinClient } from '@server/media-servers/jellyfin-client.js';
import { buildRemoteCatalog } from '@server/media-servers/catalog.js';

for (const provider of ['jellyfin', 'emby'] as const) {
	describe(`${provider} artwork versions`, () => {
		it.each(['Primary', 'Thumb', 'Backdrop', 'SeriesPrimary'] as const)('refreshes the catalog fingerprint when %s changes', async (kind) => {
			let tag = 'first / version';
			const client = new JellyfinClient(async () => ({
				ok: true,
				status: 200,
				headers: { get: () => null },
				text: async () => JSON.stringify({
					TotalRecordCount: 1,
					Items: [{
						Id: 'episode', Name: 'Pilot', SeriesId: 'series', SeriesName: 'Example',
						ParentIndexNumber: 1, IndexNumber: 1,
						MediaSources: [{ Id: 'source', Path: '/shows/pilot.mkv' }],
						ImageTags: { Primary: kind === 'Primary' ? tag : 'poster', Thumb: kind === 'Thumb' ? tag : 'thumb' },
						BackdropImageTags: [kind === 'Backdrop' ? tag : 'backdrop'],
						SeriesPrimaryImageTag: kind === 'SeriesPrimary' ? tag : 'series-poster',
					}],
				}),
				arrayBuffer: async () => new ArrayBuffer(0),
				body: null,
			}), {
				provider, baseUrl: 'https://media.example', accessToken: 'synthetic-token',
				clientIdentifier: 'test-client', allowInsecureTls: false,
			});
			const firstItems = await client.listItems('shows', 'shows');
			const first = await buildRemoteCatalog({ libraryId: 'library', mediaServerId: 'server', replacements: [], items: firstItems });
			tag = 'second / version';
			const secondItems = await client.listItems('shows', 'shows');
			const second = await buildRemoteCatalog({ libraryId: 'library', mediaServerId: 'server', replacements: [], items: secondItems });
			const repeated = await buildRemoteCatalog({ libraryId: 'library', mediaServerId: 'server', replacements: [], items: await client.listItems('shows', 'shows') });
			if (kind === 'SeriesPrimary') {
				const previous = first.groups.find((group) => group.kind === 'show');
				const current = second.groups.find((group) => group.kind === 'show');
				expect(previous).toBeDefined();
				expect(current?.metadata.artworkFingerprint).not.toBe(previous?.metadata.artworkFingerprint);
				expect(current?.metadata.artworkFingerprint).toBe(repeated.groups.find((group) => group.kind === 'show')?.metadata.artworkFingerprint);
			}
			else {
				expect(second.items[0]?.metadata.artworkFingerprint).not.toBe(first.items[0]?.metadata.artworkFingerprint);
				expect(second.items[0]?.metadata.artworkFingerprint).toBe(repeated.items[0]?.metadata.artworkFingerprint);
			}

			const image = kind === 'SeriesPrimary' ? secondItems[0]?.show?.posterPath
				: kind === 'Primary' ? secondItems[0]?.posterPath
					: kind === 'Thumb' ? secondItems[0]?.landscapePath : secondItems[0]?.fanartPath;
			expect(new URL(client.artworkRequest(image!).url).searchParams.get('tag')).toBe(tag);
		});
	});
}
