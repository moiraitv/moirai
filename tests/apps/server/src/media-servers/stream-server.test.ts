import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { expect, it } from 'vitest';
import { createDatabase } from '@server/db/index.js';
import { Repository } from '@server/repository/index.js';
import { MediaStreamServer } from '@server/media-servers/stream-server.js';
import { mediaStreamUrl, signMediaStream } from '@server/media-servers/stream-url.js';

it('uses a private loopback listener for signed Range reads and closes it after use', async () => {
	const token = 'synthetic-private-stream-token';
	const requests: Array<{ token: unknown; range: unknown }> = [];
	const upstream = createServer((request, response) => {
		requests.push({ token: request.headers['x-plex-token'], range: request.headers.range });
		response.writeHead(206, { 'content-range': 'bytes 0-3/9', 'content-type': 'text/html' });
		response.end('part');
	});
	await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
	const database = createDatabase(':memory:', path.resolve('drizzle'));
	const repository = new Repository(database.db);
	const secret = 'synthetic-signing-secret-long-enough';
	const service = new MediaStreamServer(repository, secret);
	try {
		const server = await repository.mediaServers.createMediaServer({ provider: 'plex', name: 'Audit', baseUrl: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`, accessToken: token, allowInsecureTls: false, playbackReportingEnabled: false, pathReplacements: [] }, { serverKey: 'audit', serverName: 'Audit', libraries: [] });
		const origin = await service.start();
		expect(new URL(origin).hostname).toBe('127.0.0.1');
		expect(Number(new URL(origin).port)).toBeGreaterThan(0);
		const expiry = Date.now() + 60_000;
		const url = mediaStreamUrl(origin, server.id, '7', expiry, signMediaStream(secret, expiry, server.id, '7'));
		const response = await fetch(url, { headers: { Range: 'bytes=0-3' } });
		expect(response.status).toBe(206);
		expect(await response.text()).toBe('part');
		expect(response.headers.get('content-range')).toBe('bytes 0-3/9');
		expect(response.headers.get('content-type')).toContain('application/octet-stream');
		expect(response.headers.get('x-content-type-options')).toBe('nosniff');
		expect(requests).toEqual([{ token, range: 'bytes=0-3' }]);
		const expired = Date.now() - 1;
		expect((await fetch(mediaStreamUrl(origin, server.id, '7', expired, signMediaStream(secret, expired, server.id, '7')))).status).toBe(403);
		expect(requests).toHaveLength(1);
		await service.close();
		await expect(fetch(url)).rejects.toThrow();
	}
	finally {
		await service.close();
		database.close();
		await new Promise<void>((resolve) => upstream.close(() => resolve()));
	}
});
