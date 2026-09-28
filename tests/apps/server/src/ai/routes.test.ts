import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { validatorCompiler } from 'fastify-type-provider-zod';
import { afterEach, expect, it, vi } from 'vitest';
import { loadConfig } from '@server/config.js';
import type { Repository } from '@server/repository/index.js';
import type { AuthenticationSessionRecord } from '@server/auth/contracts.js';
import { registerAiRoutes } from '@server/routes/ai.js';
import { responseSerializerCompiler } from '@server/routes/contracts.js';
import { publicError } from '@server/routes/public-errors.js';

afterEach(() => vi.unstubAllGlobals());

it('rejects selections above the configured limit and accepts the exact boundary', async () => {
	const limit = 2;
	const libraryId = randomUUID();
	const catalog = Array.from({ length: limit + 1 }, (_, index) => ({
		id: randomUUID(), title: `Movie ${index}`, year: 2026, kind: 'movie', genres: ['Action'],
	}));
	let matches = catalog;
	vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
		const body = JSON.parse(String(init.body));
		const rows = body.messages[1].content.split('\n').filter((line: string) => line.startsWith('[')).map((line: string) => JSON.parse(line));
		return Response.json({ choices: [{ message: { content: JSON.stringify({ concepts: ['movies'], constraints: [], candidates: [],
			matches: rows.filter((row: string[]) => matches.some(item => item.title === row[1])).map((row: string[]) => row[0]),
		}) } }] });
	}));
	const app = Fastify();
	app.addHook('onRequest', async request => {
		request.authenticationSession = { identity: { id: randomUUID() } } as AuthenticationSessionRecord;
	});
	app.setValidatorCompiler(validatorCompiler);
	app.setSerializerCompiler(responseSerializerCompiler);
	app.setErrorHandler((error, request, reply) => {
		const mapped = publicError(error, request.id);
		reply.status(mapped.statusCode).send(mapped.body);
	});
	registerAiRoutes(app, {
		config: loadConfig({ maxExplicitMediaItems: limit, ai: {
			apiKey: 'test', baseUrl: 'https://ai.example.test/v1', model: 'test', webSearch: false,
		} }),
		repository: {
			getLibrary: async () => ({ id: libraryId }),
			aiCatalog: async () => catalog,
			semantic: { retrievalVectors: () => ({}), preferences: { catalog: () => ({ movies: { status: 'ready', vector: [1, 0] } }) } },
		} as unknown as Repository,
	});
	try {
		const request = { method: 'POST' as const, url: '/api/v1/ai/content-selection',
			payload: { libraryId, prompt: 'All movies' } };
		const rejected = await app.inject(request);
		expect(rejected.statusCode).toBe(422);
		expect(rejected.json().message).toContain(String(limit));
		expect(rejected.json().message).toContain('Narrow the prompt');
		const rejectedStream = await app.inject({ ...request, headers: { accept: 'text/event-stream' } });
		expect(rejectedStream.statusCode).toBe(200);
		expect(rejectedStream.body).toContain('"type":"error"');
		expect(rejectedStream.body).not.toContain('"type":"result"');

		matches = catalog.slice(0, limit);
		const accepted = await app.inject(request);
		expect(accepted.statusCode).toBe(200);
		expect(accepted.json().itemIds).toHaveLength(limit);
		expect(accepted.json().itemIds).toEqual(expect.arrayContaining(matches.map(item => item.id)));
		const streamed = await app.inject({ ...request, headers: { accept: 'text/event-stream' } });
		expect(streamed.headers['content-type']).toContain('text/event-stream');
		const events = streamed.body.trim().split('\n\n').map(line => JSON.parse(line.slice(6)));
		expect(events.at(-1)).toEqual({ type: 'result', result: accepted.json() });
		expect(events.some(event => event.type === 'progress' && event.status === 'reviewing')).toBe(true);
	}
	finally {
		await app.close();
	}
});

it('publishes provider guidance and hides unexpected one-shot failures', async () => {
	const libraryId = randomUUID();
	const item = { id: randomUUID(), title: 'Movie', year: 2020, kind: 'movie', genres: [] as string[] };
	let mode: 'internal' | 'unauthorized' = 'internal';
	vi.stubGlobal('fetch', vi.fn(async () => {
		if (mode === 'internal') {
			throw new Error('SQLITE_ERROR near /secret/library.sqlite');
		}
		return new Response('private upstream diagnostic', { status: 401 });
	}));
	const app = Fastify();
	app.addHook('onRequest', async request => {
		request.authenticationSession = { identity: { id: randomUUID() } } as AuthenticationSessionRecord;
	});
	app.setValidatorCompiler(validatorCompiler);
	app.setSerializerCompiler(responseSerializerCompiler);
	app.setErrorHandler((error, request, reply) => {
		const mapped = publicError(error, request.id);
		reply.status(mapped.statusCode).send(mapped.body);
	});
	registerAiRoutes(app, {
		config: loadConfig({ ai: { apiKey: 'test', baseUrl: 'https://ai.example.test/v1', model: 'test', webSearch: false } }),
		repository: {
			getLibrary: async () => ({ id: libraryId, typeKey: 'movies' }),
			aiCatalog: async () => [item],
			semantic: { retrievalVectors: () => ({}), preferences: { catalog: () => ({}) } },
		} as unknown as Repository,
	});
	try {
		const request = { method: 'POST' as const, url: '/api/v1/ai/content-selection', payload: { libraryId, prompt: 'Movies' } };
		const rejected = await app.inject(request);
		expect(rejected.statusCode).toBe(422);
		expect(rejected.json().message).toBe('Generation failed. Try again.');
		expect(rejected.body).not.toContain('/secret');
		const streamed = await app.inject({ ...request, headers: { accept: 'text/event-stream' } });
		expect(streamed.body).toContain('Generation failed. Try again.');
		expect(streamed.body).not.toContain('/secret');
		mode = 'unauthorized';
		const guided = await app.inject(request);
		expect(guided.statusCode).toBe(422);
		expect(guided.json().message).toContain('HTTP 401');
		expect(guided.json().message).toContain('API key');
		expect(guided.body).not.toContain('private upstream');
	}
	finally {
		await app.close();
	}
});

it('applies generation capacity to one-shot selection', async () => {
	const libraryId = randomUUID();
	const owner = randomUUID();
	vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
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
	registerAiRoutes(app, {
		config: loadConfig({ ai: { apiKey: 'test', baseUrl: 'https://ai.example.test/v1', model: 'test', webSearch: false } }),
		repository: {
			getLibrary: async () => ({ id: libraryId, typeKey: 'movies' }),
			aiCatalog: async () => [{ id: randomUUID(), title: 'Movie', year: 2020, kind: 'movie', genres: [] }],
			semantic: { retrievalVectors: () => ({}), preferences: { catalog: () => ({}) } },
		} as unknown as Repository,
	});
	try {
		for (let index = 0; index < 2; index += 1) {
			const started = await app.inject({ method: 'POST', url: '/api/v1/ai/generations', payload: {
				id: randomUUID(), libraryId, prompt: 'Movies',
			} });
			expect(started.statusCode).toBe(202);
		}
		const blocked = await app.inject({ method: 'POST', url: '/api/v1/ai/content-selection', payload: { libraryId, prompt: 'Movies' } });
		expect(blocked.statusCode).toBe(503);
		expect(blocked.json().message).toContain('Generation capacity reached');
		expect(blocked.json().message).not.toContain('temporarily unavailable');
	}
	finally {
		await app.close();
	}
});
