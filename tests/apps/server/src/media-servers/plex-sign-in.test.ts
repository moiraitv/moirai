import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { validatorCompiler } from 'fastify-type-provider-zod';
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { plexServerToken } from '@server/media-servers/plex-sign-in.js';
import { MediaServerRequestError } from '@server/media-servers/http.js';
import { registerMediaServerRoutes } from '@server/routes/media-servers.js';
import { responseSerializerCompiler } from '@server/routes/contracts.js';
import { publicError } from '@server/routes/public-errors.js';
import { expect, it } from 'vitest';
import type { MediaFetch, MediaFetchInit, MediaFetchResponse } from '@server/media-servers/http.js';
import { PlexClient } from '@server/media-servers/plex-client.js';

/** Respond with the shape Plex returns for one sign-in step. */
function jsonResponse(body: unknown): MediaFetchResponse {
	return {
		ok: true, status: 200, headers: { get: () => null }, body: null,
		text: async () => JSON.stringify(body), arrayBuffer: async () => new ArrayBuffer(0),
	};
}

it('creates a four-character manual-link PIN and polls its token using the same client identity', async () => {
	const clientIdentifier = 'moirai-sign-in-client';
	const requests: Array<{ url: URL; init: MediaFetchInit | undefined }> = [];
	let authorized = false;
	const fetch: MediaFetch = async (address, init) => {
		const url = new URL(address);
		requests.push({ url, init });
		if (init?.method === 'POST') {
			const body = new URLSearchParams(init.body);
			const strong = url.searchParams.get('strong') ?? body.get('strong');
			return jsonResponse({ id: 123, code: strong === 'true' ? 'long-code-for-hosted-auth' : 'ABCD' });
		}

		expect(url.pathname).toBe('/api/v2/pins/123');
		return jsonResponse({ authToken: authorized ? 'synthetic-plex-access-token' : null });
	};

	const pin = await PlexClient.createPin(fetch, clientIdentifier);
	expect(pin).toEqual({ pinId: 123, code: 'ABCD' });
	expect(requests[0]!.url.origin).toBe('https://plex.tv');
	expect(requests[0]!.url.pathname).toBe('/api/v2/pins');
	expect(await PlexClient.pollPin(fetch, clientIdentifier, pin.pinId)).toBeNull();
	authorized = true;
	expect(await PlexClient.pollPin(fetch, clientIdentifier, pin.pinId)).toBe('synthetic-plex-access-token');
	expect(requests.every(request => request.init?.headers?.['X-Plex-Client-Identifier'] === clientIdentifier)).toBe(true);
	expect(requests.every(request => request.init?.headers?.Accept === 'application/json')).toBe(true);
});

it('selects only the credential for the exact Plex-advertised destination without contacting it', async () => {
	const requests: Array<{ url: URL; init: MediaFetchInit | undefined }> = [];
	const account = 'synthetic-account-token';
	const resource = 'synthetic-resource-token';
	const fetch: MediaFetch = async (address, init) => {
		requests.push({ url: new URL(address), init });
		return jsonResponse([
			{ provides: 'player', accessToken: null, connections: null },
			{ provides: 'server', accessToken: 'another-server-token', connections: [{ uri: 'https://other.example' }] },
			{ provides: 'server', accessToken: resource, connections: [{ uri: 'https://PMS.example:443/plex/' }] },
		]);
	};
	const token = await plexServerToken(fetch, 'synthetic-client', account, 'https://pms.example/plex');
	expect(token).toBe(resource);
	expect(requests).toHaveLength(1);
	expect(requests[0]!.url.origin).toBe('https://clients.plex.tv');
	expect(requests[0]!.url.pathname).toBe('/api/v2/resources');
	expect(requests[0]!.init?.headers?.['X-Plex-Token']).toBe(account);
	expect(requests[0]!.init?.headers?.['X-Plex-Client-Identifier']).toBe('synthetic-client');
});

it.each([
	'https://attacker.example/plex',
	'http://pms.example/plex',
	'https://pms.example/other',
	'https://pms.example:444/plex',
])('refuses a non-advertised destination %s without sending it any credential', async address => {
	const contacted: string[] = [];
	const fetch: MediaFetch = async url => {
		contacted.push(new URL(url).origin);
		return jsonResponse([{ provides: 'server', accessToken: 'synthetic-resource-token', connections: [{ uri: 'https://pms.example/plex' }] }]);
	};
	await expect(plexServerToken(fetch, 'synthetic-client', 'synthetic-account-token', address)).rejects.toThrow(/advertised/);
	expect(contacted).toEqual(['https://clients.plex.tv']);
});

it.each([
	null,
	[{ provides: 'server', accessToken: null, connections: [{ uri: 'https://pms.example' }] }],
	[{ provides: 'server', accessToken: 'synthetic-account-token\nunsafe', connections: [{ uri: 'https://pms.example' }] }],
	[1, 2].map(() => ({ provides: 'server', accessToken: 'synthetic-resource-token', connections: [{ uri: 'https://pms.example' }] })),
])('rejects malformed, missing, or ambiguous resource credentials safely: %#', async body => {
	try {
		await plexServerToken(async () => jsonResponse(body), 'synthetic-client', 'synthetic-account-token', 'https://pms.example');
		throw new Error('Expected discovery to fail');
	}
	catch (error) {
		expect(error).toBeInstanceOf(MediaServerRequestError);
		expect(String(error)).not.toContain('synthetic-account-token');
		expect(String(error)).not.toContain('synthetic-resource-token');
	}
});

it('returns only the destination resource token from the real PIN route and uses it for inspection', async () => {
	const previous = getGlobalDispatcher();
	const dispatcher = new MockAgent();
	dispatcher.disableNetConnect();
	setGlobalDispatcher(dispatcher);
	const app = Fastify();
	try {
		app.setValidatorCompiler(validatorCompiler);
		app.setSerializerCompiler(responseSerializerCompiler);
		await app.register(sensible);
		app.setErrorHandler((error, request, reply) => {
			const mapped = publicError(error, request.id);
			reply.status(mapped.statusCode).send(mapped.body);
		});
		registerMediaServerRoutes(app, { repository: {} as never, scanner: {} as never });
		dispatcher.get('https://plex.tv').intercept({ path: '/api/v2/pins/123' })
			.reply(200, { authToken: 'synthetic-account-token' });
		dispatcher.get('https://clients.plex.tv').intercept({
			path: '/api/v2/resources?includeHttps=1&includeRelay=1&includeIPv6=1',
			headers: { 'x-plex-token': 'synthetic-account-token' },
		}).reply(200, [{ provides: 'server', accessToken: 'synthetic-resource-token', connections: [{ uri: 'https://pms.example' }] }]);
		const query = new URLSearchParams({ clientIdentifier: 'synthetic-client', baseUrl: 'https://pms.example' });
		const poll = await app.inject(`/api/v1/media-servers/plex/pin/123?${query}`);
		expect(poll.statusCode).toBe(200);
		expect(poll.json()).toEqual({ accessToken: 'synthetic-resource-token', clientIdentifier: 'synthetic-client' });
		expect(poll.body).not.toContain('synthetic-account-token');

		const headers = { 'x-plex-token': 'synthetic-resource-token' };
		dispatcher.get('https://pms.example').intercept({ path: '/identity', headers })
			.reply(200, { MediaContainer: { machineIdentifier: 'pms' } });
		dispatcher.get('https://pms.example').intercept({ path: '/library/sections', headers })
			.reply(200, { MediaContainer: { Directory: [] } });
		const probe = await app.inject({ method: 'POST', url: '/api/v1/media-servers/probe', payload: {
			provider: 'plex', baseUrl: 'https://pms.example', accessToken: poll.json().accessToken,
			clientIdentifier: 'synthetic-client',
		} });
		expect(probe.statusCode).toBe(200);
		expect(probe.body).not.toContain('synthetic-account-token');
		dispatcher.assertNoPendingInterceptors();

		const unbound = await app.inject('/api/v1/media-servers/plex/pin/123?clientIdentifier=synthetic-client');
		expect(unbound.statusCode).toBe(400);
		expect(unbound.body).not.toContain('synthetic-account-token');
	}
	finally {
		await app.close();
		setGlobalDispatcher(previous);
		await dispatcher.close();
	}
});
