import { Readable } from 'node:stream';
import sensible from '@fastify/sensible';
import Fastify from 'fastify';
import { validatorCompiler } from 'fastify-type-provider-zod';
import { describe, expect, it } from 'vitest';
import type { MediaFetchResponse } from '@server/media-servers/http.js';
import { mediaStreamUrl, signMediaStream } from '@server/media-servers/stream-url.js';
import type { Repository } from '@server/repository/index.js';
import { responseSerializerCompiler } from '@server/routes/contracts.js';
import { publicError } from '@server/routes/public-errors.js';
import { registerMediaStreamRoutes } from '@server/routes/media-stream.js';

const SERVER_ID = '11111111-1111-4111-8111-111111111111';
const SECRET = 'stream-secret-that-is-long-enough';

/** Build the loopback route with a scripted upstream. */
async function appFor(
	fetchBody: (url: string, range: string | null) => MediaFetchResponse,
) {
	const app = Fastify();
	app.setValidatorCompiler(validatorCompiler);
	app.setSerializerCompiler(responseSerializerCompiler);
	app.setErrorHandler((error, request, reply) => {
		const mapped = publicError(error, request.id);
		reply.status(mapped.statusCode).send(mapped.body);
	});
	await app.register(sensible);
	const seen: string[] = [];
	registerMediaStreamRoutes(app, {
		secret: SECRET,
		repository: {
			mediaServers: {
				getMediaServerConnection: async () => ({
					id: SERVER_ID,
					provider: 'plex',
					name: 'Plex',
					baseUrl: 'http://plex.test',
					serverKey: 'machine-1',
					serverName: 'Plex',
					clientIdentifier: 'moirai-client',
					accessToken: 'secret-token',
					allowInsecureTls: false,
					pathReplacements: [],
				}),
			},
		} as unknown as Repository,
		fetchFor: () => async (url, init) => {
			seen.push(url);
			return fetchBody(url, init?.headers?.Range ?? null);
		},
	});
	return { app, seen };
}

describe('signed media streams', () => {
	it('rejects a loopback request whose signature does not match', async () => {
		const { app } = await appFor(() => {
			throw new Error('upstream should not be called');
		});
		const url = mediaStreamUrl('http://127.0.0.1:3000', SERVER_ID, '7', Date.now() + 60_000, 'not-the-signature');
		const response = await app.inject({ method: 'GET', url, remoteAddress: '127.0.0.1' });
		expect(response.statusCode).toBe(403);
		await app.close();
	});

	it('forwards a byte range and hides the provider credential from the worker URL', async () => {
		const { app, seen } = await appFor((url, range) => ({
			ok: true,
			status: 206,
			headers: {
				get: (name: string) => {
					if (name === 'content-type') {
						return 'video/matroska';
					}

					if (name === 'content-range') {
						return 'bytes 0-3/9';
					}

					if (name === 'accept-ranges') {
						return 'bytes';
					}

					return name === 'content-length' ? '4' : null;
				},
			},
			text: async () => '',
			arrayBuffer: async () => new ArrayBuffer(0),
			body: range === 'bytes=0-3' ? Readable.toWeb(Readable.from(Buffer.from('part'))) as MediaFetchResponse['body'] : null,
		}));
		const expiresAt = Date.now() + 60_000;
		const signature = signMediaStream(SECRET, expiresAt, SERVER_ID, '7');
		const url = mediaStreamUrl('http://127.0.0.1:3000', SERVER_ID, '7', expiresAt, signature);
		expect(url).not.toContain('secret-token');
		const response = await app.inject({
			method: 'GET',
			url: url.slice('http://127.0.0.1:3000'.length),
			remoteAddress: '127.0.0.1',
			headers: { range: 'bytes=0-3' },
		});
		expect(response.statusCode).toBe(206);
		expect(response.headers['content-range']).toBe('bytes 0-3/9');
		expect(response.body).toBe('part');
		expect(seen[0]).toContain('/library/parts/7/file');
		expect(seen[0]).not.toContain('secret-token');
		await app.close();
	});

	it('accepts only loopback peers and rejects a main listener address', async () => {
		const { app } = await appFor(() => {
			throw new Error('upstream should not be called');
		});
		const expiresAt = Date.now() + 60_000;
		const signature = signMediaStream(SECRET, expiresAt, SERVER_ID, '7');
		const url = mediaStreamUrl('http://192.168.1.9:3000', SERVER_ID, '7', expiresAt, signature)
			.slice('http://192.168.1.9:3000'.length);
		const outsider = await app.inject({ method: 'GET', url, remoteAddress: '10.0.0.8' });
		expect(outsider.statusCode).toBe(403);
		expect(outsider.body).toContain('local playback worker');
		const local = await app.inject({ method: 'GET', url, remoteAddress: '192.168.1.9' });
		expect(local.statusCode).toBe(403);
		await app.close();
	});
});
