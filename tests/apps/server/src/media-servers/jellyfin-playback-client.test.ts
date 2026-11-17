import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, it } from 'vitest';
import { createMediaFetch } from '@server/media-servers/http.js';
import { JellyfinPlaybackClient } from '@server/media-servers/jellyfin-playback-client.js';

it('sends authenticated lifecycle reports over HTTP and preserves Unicode channel names safely', async () => {
	const received: Array<{ method: string; url: string; authorization: string; body: Record<string, unknown> }> = [];
	const upstream = createServer(async (request, response) => {
		const chunks: Buffer[] = [];
		for await (const chunk of request) {
			chunks.push(chunk);
		}
		received.push({
			method: request.method!, url: request.url!, authorization: request.headers.authorization!,
			body: JSON.parse(Buffer.concat(chunks).toString()),
		});
		response.writeHead(request.url!.endsWith('/Stopped') ? 503 : 204);
		response.end();
	});
	await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
	try {
		const client = new JellyfinPlaybackClient(createMediaFetch(false), {
			provider: 'jellyfin', baseUrl: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/jellyfin`,
			clientIdentifier: 'moirai-device', accessToken: 'synthetic-token', allowInsecureTls: false,
		}, { id: 'channel', number: '1', name: 'Cinéma "été"\r\nTV' });
		const report = { ItemId: 'movie', MediaSourceId: 'source', PlaySessionId: 'airing', PositionTicks: 123 };
		await client.report('start', report);
		await client.report('progress', { ...report, PositionTicks: 456 });
		await expect(client.report('stop', report)).rejects.toMatchObject({ status: 503 });
		expect(received.map(request => request.url)).toEqual([
			'/jellyfin/Sessions/Playing', '/jellyfin/Sessions/Playing/Progress', '/jellyfin/Sessions/Playing/Stopped',
		]);
		expect(received.every(request => request.method === 'POST')).toBe(true);
		expect(received[0]!.body).toMatchObject({ ...report, CanSeek: false, PlayMethod: 'DirectPlay' });
		expect(received[1]!.body.PositionTicks).toBe(456);
		expect(received[0]!.authorization).not.toMatch(/[\r\n]/);
		expect(decodeURIComponent(received[0]!.authorization)).toContain('Moirai · 1 Cinéma "été"  TV');
		expect(received[0]!.authorization).toContain('Token="synthetic-token"');
	}
	finally {
		upstream.closeAllConnections();
		await new Promise<void>(resolve => upstream.close(() => resolve()));
	}
});
