import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, it } from 'vitest';
import { createMediaFetch } from '@server/media-servers/http.js';
import { PlexPlaybackClient } from '@server/media-servers/plex-playback-client.js';

it('sends authenticated Plex timelines over HTTP with a stable channel identity and safe Unicode names', async () => {
	const received: Array<{ method: string; url: URL; headers: import('node:http').IncomingHttpHeaders }> = [];
	const upstream = createServer((request, response) => {
		received.push({ method: request.method!, url: new URL(request.url!, 'http://local'), headers: request.headers });
		response.writeHead(received.length === 3 ? 503 : 200);
		response.end();
	});
	await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
	try {
		const connection = {
			provider: 'plex' as const, baseUrl: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/plex`,
			clientIdentifier: 'moirai-device', accessToken: 'synthetic-token', allowInsecureTls: false,
		};
		const client = new PlexPlaybackClient(createMediaFetch(false), connection, { id: 'channel', number: '700.2', name: 'Cinéma "été"\r\nTV' });
		const report = { ratingKey: '42', sessionId: 'airing', positionMilliseconds: 123, durationMilliseconds: 1_000 };
		await client.report('start', report);
		await client.report('progress', { ...report, positionMilliseconds: 456 });
		await expect(client.report('stop', { ...report, positionMilliseconds: 2_000 })).rejects.toMatchObject({ status: 503 });
		expect(received.every(request => request.method === 'POST' && request.url.pathname === '/plex/:/timeline')).toBe(true);
		expect(received.map(request => request.url.searchParams.get('state'))).toEqual(['playing', 'playing', 'stopped']);
		expect(received.map(request => request.url.searchParams.get('time'))).toEqual(['123', '456', '1000']);
		expect(Object.fromEntries(received[0]!.url.searchParams)).toMatchObject({
			key: '/library/metadata/42', ratingKey: '42', duration: '1000', identifier: 'com.plexapp.plugins.library',
		});
		expect(received.every(request => request.headers['x-plex-token'] === connection.accessToken)).toBe(true);
		expect(received.every(request => request.headers['x-plex-session-identifier'] === 'airing')).toBe(true);
		expect(new Set(received.map(request => request.headers['x-plex-client-identifier'])).size).toBe(1);
		expect(received[0]!.url.href).not.toContain(connection.accessToken);
		const name = Buffer.from(String(received[0]!.headers['x-plex-device-name']), 'latin1').toString('utf8');
		expect(name).toBe('Moirai · 700.2 Cinéma "été"  TV');
		expect(received[0]!.headers['x-plex-product']).toBe('Moirai');
	}
	finally {
		upstream.closeAllConnections();
		await new Promise<void>(resolve => upstream.close(() => resolve()));
	}
});
