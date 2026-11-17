import { describe, expect, it } from 'vitest';
import { readJson, type MediaFetchResponse } from '@server/media-servers/http.js';
import { MediaListingBudget } from '@server/media-servers/listing-budget.js';
import { MEDIA_JSON_MAX_BYTES, MEDIA_LISTING_MAX_BYTES, MEDIA_LISTING_MAX_ITEMS, MEDIA_LISTING_MAX_PAGES } from '@server/media-servers/limits.js';
import { PlexClient } from '@server/media-servers/plex-client.js';
import { JellyfinClient } from '@server/media-servers/jellyfin-client.js';

function response(text: string): MediaFetchResponse {
	return { ok: true, status: 200, headers: { get: () => null }, text: async () => text, arrayBuffer: async () => new ArrayBuffer(0), body: null };
}
const connection = { provider: 'plex' as const, baseUrl: 'https://audit.test', accessToken: 'audit-token', clientIdentifier: 'audit-client', allowInsecureTls: false };

describe('provider resource limits', () => {
	it('cancels a chunked JSON body as soon as its byte limit is exceeded', async () => {
		let cancelled = false;
		let pulls = 0;
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				pulls += 1;
				controller.enqueue(new Uint8Array(MEDIA_JSON_MAX_BYTES / 2 + 1));
			},
			cancel() {
				cancelled = true;
			},
		}, { highWaterMark: 0 });
		await expect(readJson({ ...response(''), body }, 'Plex')).rejects.toThrow(/byte limit/);
		expect(cancelled).toBe(true);
		expect(pulls).toBe(2);
	});

	it('bounds cumulative decoded bytes, pages, and retained records', () => {
		const bytes = new MediaListingBudget();
		bytes.consumeBytes(MEDIA_LISTING_MAX_BYTES);
		expect(() => bytes.consumeBytes(1)).toThrow(/byte limit/);
		const pages = new MediaListingBudget();
		for (let page = 0; page < MEDIA_LISTING_MAX_PAGES; page += 1) {
			pages.nextPage();
		}
		expect(() => pages.nextPage()).toThrow(/page limit/);
		expect(() => new MediaListingBudget().acceptPage(new Array(MEDIA_LISTING_MAX_ITEMS + 1), undefined)).toThrow(/item limit/);
	});

	it.each([Infinity, NaN, -1, 0.5, MEDIA_LISTING_MAX_ITEMS + 1])('rejects invalid totals before paging further: %s', async (total) => {
		let requests = 0;
		const client = new PlexClient(async () => {
			requests += 1;
			return response(`{"MediaContainer":{"totalSize":${total === Infinity ? '1e400' : JSON.stringify(total)},"Metadata":[{"ratingKey":"1","title":"Audit"}]}}`);
		}, connection);
		await expect(client.listItems('1', 'movies')).rejects.toThrow(/invalid library total/);
		expect(requests).toBe(1);
	});

	it('rejects changing totals and duplicate identifiers across nonadjacent pages', () => {
		const totals = new MediaListingBudget();
		totals.acceptPage(['first'], 3);
		expect(() => totals.acceptPage(['second'], 4)).toThrow(/changed.*total/);
		const duplicates = new MediaListingBudget();
		duplicates.acceptPage(['first'], 3);
		duplicates.acceptPage(['second'], 3);
		expect(() => duplicates.acceptPage(['first'], 3)).toThrow(/repeated/);
	});

	it('rejects a nonfinite Jellyfin total before a second request', async () => {
		let requests = 0;
		const client = new JellyfinClient(async () => {
			requests += 1;
			return response('{"TotalRecordCount":1e400,"Items":[{"Id":"1","Name":"Audit"}]}');
		}, { ...connection, provider: 'jellyfin' });
		await expect(client.listItems('1', 'movies')).rejects.toThrow(/invalid library total/);
		expect(requests).toBe(1);
	});
	it.each(['plex', 'jellyfin', 'emby'] as const)('rejects a disappearing %s total instead of committing partial results', async (provider) => {
		let requests = 0;
		const fetch = async () => {
			requests += 1;
			const body = provider === 'plex'
				? requests === 1 ? { MediaContainer: { totalSize: 2, Metadata: [{ ratingKey: '1', title: 'Audit' }] } } : { MediaContainer: { Metadata: [] } }
				: requests === 1 ? { TotalRecordCount: 2, Items: [{ Id: '1', Name: 'Audit', Type: 'Movie' }] } : { Items: [] };
			return response(JSON.stringify(body));
		};
		const client = provider === 'plex' ? new PlexClient(fetch, connection) : new JellyfinClient(fetch, { ...connection, provider });
		await expect(client.listItems('1', 'movies')).rejects.toThrow(/stopped reporting.*total/);
		expect(requests).toBe(2);
	});

});
