import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MEDIA_REQUEST_TIMEOUT_MS } from '@server/media-servers/limits.js';
import { readJson, createMediaFetch } from '@server/media-servers/http.js';
import { normalizeBaseUrl, mediaServerUrl } from '@server/media-servers/http.js';

/** Listen on an ephemeral port and return the base URL plus a way to stop. */
async function listen(handler: (requestUrl: string, token: string | undefined, response: ServerResponse) => void) {
	const server = createServer((request, response) => {
		const token = request.headers['x-plex-token'];
		handler(request.url ?? '', typeof token === 'string' ? token : undefined, response);
	});
	await new Promise<void>((resolve) => {
		server.listen(0, '127.0.0.1', () => resolve());
	});
	const address = server.address() as AddressInfo;
	return {
		origin: `http://127.0.0.1:${address.port}`,
		close: () => new Promise<void>((resolve, reject) => {
			server.close((error) => error ? reject(error) : resolve());
		}),
	};
}

afterEach(() => vi.restoreAllMocks());

describe('media server HTTP', () => {
	it('follows a same-origin redirect and refuses to send the token to another address', async () => {
		const seen: string[] = [];
		const target = await listen((url, token, response) => {
			seen.push(`${url}:${token ?? ''}`);
			response.writeHead(200, { 'content-type': 'application/json' });
			response.end('{"ok":true}');
		});
		const source = await listen((url, token, response) => {
			seen.push(`${url}:${token ?? ''}`);
			if (url === '/away') {
				response.writeHead(302, { location: `${target.origin}/secret` });
				response.end();
				return;
			}

			if (url === '/file') {
				response.writeHead(200, { 'content-type': 'application/json' });
				response.end('{"ok":true}');
				return;
			}

			response.writeHead(302, { location: '/file' });
			response.end();
		});
		const fetch = createMediaFetch(false);
		const sameOrigin = await fetch(`${source.origin}/start`, { headers: { 'X-Plex-Token': 'secret-token' } });
		expect(sameOrigin.status).toBe(200);
		await expect(fetch(`${source.origin}/away`, { headers: { 'X-Plex-Token': 'secret-token' } }))
			.rejects.toThrow(/different address/);
		expect(seen).toContain('/start:secret-token');
		expect(seen).toContain('/file:secret-token');
		expect(seen.some((entry) => entry.startsWith('/secret:'))).toBe(false);
		await source.close();
		await target.close();
	});

	it('rejects credentials in URLs while preserving reverse-proxy base paths', () => {
		for (const value of ['https://host.test?api_key=secret', 'https://host.test#secret', 'https://user:pass@host.test']) {
			expect(() => normalizeBaseUrl(value)).toThrow();
		}
		expect(mediaServerUrl('https://host.test/plex/', '/identity')).toBe('https://host.test/plex/identity');
		expect(() => mediaServerUrl('https://host.test', '//other.test/image')).toThrow();
		expect(() => mediaServerUrl('https://host.test', '/\\other.test/image')).toThrow();
	});
});


it('applies the metadata deadline through body consumption and leaves playback to caller cancellation', async () => {
	const deadline = new AbortController();
	const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
	const source = await listen((_url, _token, response) => {
		response.writeHead(200, { 'content-type': 'application/json' });
		response.flushHeaders();
		response.write('{');
	});
	try {
		const mediaFetch = createMediaFetch(false);
		const response = await mediaFetch(`${source.origin}/metadata`);
		const reading = readJson(response, 'Plex');
		const failure = expect(reading).rejects.toThrow(/cancelled|failed|could not read/);
		deadline.abort(new Error('synthetic-deadline-secret'));
		await failure;
		expect(timeout).toHaveBeenCalledWith(MEDIA_REQUEST_TIMEOUT_MS);
		timeout.mockClear();

		const caller = new AbortController();
		const stream = await mediaFetch(`${source.origin}/video`, { streaming: true, signal: caller.signal });
		expect(timeout).not.toHaveBeenCalled();
		const reader = stream.body!.getReader();
		expect((await reader.read()).value).toEqual(new Uint8Array([123]));
		const pending = reader.read();
		const cancellation = expect(pending).rejects.toThrow();
		caller.abort();
		await cancellation;
		reader.releaseLock();
	}
	finally {
		await source.close();
	}
});
