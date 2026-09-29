import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { validatorCompiler } from 'fastify-type-provider-zod';
import { afterEach, expect, it, vi } from 'vitest';
import { loadConfig } from '@server/config.js';
import type { Repository } from '@server/repository/index.js';
import type { AuthenticationSessionRecord } from '@server/auth/contracts.js';
import { registerAiGenerationRoutes } from '@server/routes/ai-generations.js';
import { responseSerializerCompiler } from '@server/routes/contracts.js';
import { publicError } from '@server/routes/public-errors.js';

afterEach(() => vi.unstubAllGlobals());

it('returns a reconnectable result through HTTP and enforces ownership on reads and cancellation', async () => {
	const owner = randomUUID();
	const libraryId = randomUUID();
	const item = { id: randomUUID(), title: 'Movie', year: 2020, kind: 'movie', genres: [] };
	let failFinal = false;
	let failDiscovery = false;
	const fetchMock = vi.fn(async (_url, init) => {
		const body = JSON.parse(String(init.body));
		if (failDiscovery && !body.messages[1].content.includes('Rows:')) {
			return Response.json({ choices: [{ message: { content: '{"concepts":[]}' } }] });
		}
		if (failFinal && body.messages[1].content.includes('priorCore')) {
			return new Response('', { status: 500 });
		}
		const content = body.messages[1].content.includes('Rows:')
			? { core: ['1'], supporting: [] }
			: { concepts: ['movies'], constraints: [], candidates: [] };
		return Response.json({ choices: [{ message: { content: JSON.stringify(content) } }] });
	});
	vi.stubGlobal('fetch', fetchMock);
	const app = Fastify();
	app.setValidatorCompiler(validatorCompiler);
	app.setSerializerCompiler(responseSerializerCompiler);
	app.setErrorHandler((error, request, reply) => {
		const mapped = publicError(error, request.id);
		reply.status(mapped.statusCode).send(mapped.body);
	});
	app.addHook('onRequest', async request => {
		request.authenticationSession = { identity: { id: request.headers['x-test-owner'] ?? owner } } as AuthenticationSessionRecord;
	});
	registerAiGenerationRoutes(app, {
		config: loadConfig({ ai: { apiKey: 'test', baseUrl: 'https://example.test/v1', model: 'test', webSearch: false } }),
		repository: { getLibrary: async () => ({ id: libraryId, typeKey: 'movies' }), aiCatalog: async () => [item],
			semantic: { retrievalVectors: () => ({}), preferences: { catalog: () => ({}) } },
		} as unknown as Repository,
	});
	try {
		const body = { id: randomUUID(), libraryId, prompt: 'Movies', maxResults: 100 };
		const start = { method: 'POST' as const, url: '/api/v1/ai/generations', payload: body };
		expect((await app.inject(start)).statusCode).toBe(202);
		expect((await app.inject(start)).statusCode).toBe(202);
		const url = `/api/v1/ai/generations/${body.id}`;
		await vi.waitFor(async () => {
			const response = await app.inject({ method: 'GET', url });
			expect(response.json()).toMatchObject({ state: 'completed', result: { itemIds: [item.id] } });
			expect(response.headers['cache-control']).toBe('no-store');
		});
		expect(fetchMock).toHaveBeenCalledTimes(3);
		failFinal = true;
		const secondId = randomUUID();
		expect((await app.inject({ method: 'POST', url: '/api/v1/ai/generations', payload: {
			id: secondId, libraryId, prompt: 'Movies', maxResults: 100,
		} })).statusCode).toBe(202);
		await vi.waitFor(async () => {
			const response = await app.inject({ method: 'GET', url: `/api/v1/ai/generations/${secondId}` });
			expect(response.json()).toMatchObject({ state: 'completed', result: {
				itemIds: [item.id], coverage: { finalReviewIncomplete: true },
			} });
		});
		failFinal = false;
		failDiscovery = true;
		const thirdId = randomUUID();
		expect((await app.inject({ method: 'POST', url: '/api/v1/ai/generations', payload: {
			id: thirdId, libraryId, prompt: 'Movies', maxResults: 100,
		} })).statusCode).toBe(202);
		await vi.waitFor(async () => {
			const response = await app.inject({ method: 'GET', url: `/api/v1/ai/generations/${thirdId}` });
			expect(response.json()).toMatchObject({ state: 'completed', result: {
				itemIds: [item.id], coverage: { localDiscoveryFallback: true },
			} });
		});
		for (const method of ['GET', 'DELETE'] as const) {
			expect((await app.inject({ method, url, headers: { 'x-test-owner': randomUUID() } })).statusCode).toBe(404);
		}
		expect((await app.inject({ method: 'DELETE', url })).statusCode).toBe(204);
		expect((await app.inject({ method: 'GET', url })).statusCode).toBe(404);
		expect((await app.inject(start)).statusCode).toBe(409);
	}
	finally {
		await app.close();
	}
});

it('keeps the not-configured and capacity messages', async () => {
	const owner = randomUUID();
	const libraryId = randomUUID();
	vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
	const unconfigured = Fastify();
	unconfigured.setValidatorCompiler(validatorCompiler);
	unconfigured.setSerializerCompiler(responseSerializerCompiler);
	unconfigured.setErrorHandler((error, request, reply) => {
		const mapped = publicError(error, request.id);
		reply.status(mapped.statusCode).send(mapped.body);
	});
	registerAiGenerationRoutes(unconfigured, { config: loadConfig({ ai: null }), repository: {} as Repository });
	const missing = await unconfigured.inject({ method: 'POST', url: '/api/v1/ai/generations', payload: {
		id: randomUUID(), libraryId, prompt: 'Movies',
	} });
	expect(missing.statusCode).toBe(503);
	expect(missing.json().message).toBe('AI is not configured.');
	await unconfigured.close();

	const app = Fastify();
	app.addHook('onRequest', async request => {
		request.authenticationSession = { identity: { id: owner } } as AuthenticationSessionRecord;
	});
	app.setValidatorCompiler(validatorCompiler);
	app.setSerializerCompiler(responseSerializerCompiler);
	app.setErrorHandler((error, request, reply) => {
		const mapped = publicError(error, request.id);
		reply.status(mapped.statusCode).send(mapped.body);
	});
	registerAiGenerationRoutes(app, {
		config: loadConfig({ ai: { apiKey: 'test', baseUrl: 'https://example.test/v1', model: 'test', webSearch: false } }),
		repository: {
			getLibrary: async () => ({ id: libraryId, typeKey: 'movies' }),
			aiCatalog: async () => [{ id: randomUUID(), title: 'Movie', year: 2020, kind: 'movie', genres: [] }],
			semantic: { retrievalVectors: () => ({}), preferences: { catalog: () => ({}) } },
		} as unknown as Repository,
	});
	try {
		for (let index = 0; index < 2; index += 1) {
			expect((await app.inject({ method: 'POST', url: '/api/v1/ai/generations', payload: {
				id: randomUUID(), libraryId, prompt: 'Movies',
			} })).statusCode).toBe(202);
		}
		const blocked = await app.inject({ method: 'POST', url: '/api/v1/ai/generations', payload: {
			id: randomUUID(), libraryId, prompt: 'Movies',
		} });
		expect(blocked.statusCode).toBe(503);
		expect(blocked.json().message).toContain('Generation capacity reached');
		expect(blocked.json().message).not.toContain('temporarily unavailable');
	}
	finally {
		await app.close();
	}
});
