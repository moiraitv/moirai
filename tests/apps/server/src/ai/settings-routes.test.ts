import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { expect, it, vi } from 'vitest';
import { validatorCompiler } from 'fastify-type-provider-zod';
import { AiSettingsService } from '@server/ai/settings.js';
import { loadConfig } from '@server/config.js';
import { registerAiRoutes } from '@server/routes/ai.js';
import { responseSerializerCompiler } from '@server/routes/contracts.js';
import { publicError } from '@server/routes/public-errors.js';
import type { Repository } from '@server/repository/index.js';
import type { AuthenticationSessionRecord } from '@server/auth/contracts.js';

it('activates saved profiles for both generation routes and disables only new requests', async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), 'moirai-ai-routes-'));
	const libraryId = randomUUID();
	const itemId = randomUUID();
	const fetchImpl = vi.fn(async (_url, init) => {
		const body = JSON.parse(String(init.body));
		const text = body.messages?.[1]?.content ?? '';
		const selection = text === 'Connection check.' ? { ok: true }
			: text.includes('Rows:') ? { core: [itemId], supporting: [] }
				: { concepts: ['movie'], constraints: [], candidates: [] };
		return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(selection) } }] });
	}) as unknown as typeof fetch;
	vi.stubGlobal('fetch', fetchImpl);
	const settings = new AiSettingsService(directory, fetchImpl);
	await settings.load();
	const app = Fastify();
	app.setValidatorCompiler(validatorCompiler);
	app.setSerializerCompiler(responseSerializerCompiler);
	app.setErrorHandler((error, request, reply) => {
		const mapped = publicError(error, request.id);
		reply.status(mapped.statusCode).send(mapped.body);
	});
	app.addHook('onRequest', async request => {
		request.authenticationSession = { identity: { id: randomUUID() } } as AuthenticationSessionRecord;
	});
	registerAiRoutes(app, { config: loadConfig({ ai: null }), aiSettings: settings,
		repository: { getLibrary: async () => ({ id: libraryId, typeKey: 'movies' }),
			aiCatalog: async () => [{ id: itemId, title: 'A Movie', year: 2020, kind: 'movie', genres: ['Drama'] }],
			semantic: { retrievalVectors: () => ({}), preferences: { catalog: () => ({ movies: { status: 'ready', vector: [1, 0] } }) } },
		} as unknown as Repository });
	try {
		expect((await app.inject({ method: 'GET', url: '/api/v1/ai' })).json()).toEqual({ configured: false });
		await settings.save({ activeProvider: 'openai', profile: { provider: 'openai', apiKey: 'secret', modelOverride: null, webSearch: false } });
		expect((await app.inject({ method: 'GET', url: '/api/v1/ai' })).json()).toEqual({ configured: true });
		const redacted = await app.inject({ method: 'GET', url: '/api/v1/ai/settings' });
		expect(redacted.statusCode).toBe(200);
		expect(redacted.body).not.toContain('secret');
		expect(redacted.headers['cache-control']).toBe('no-store');
		const request = { libraryId, prompt: 'A movie', maxResults: 100 };
		const oneShot = await app.inject({ method: 'POST', url: '/api/v1/ai/content-selection', payload: request });
		expect(oneShot.statusCode).not.toBe(503);
		const retained = await app.inject({ method: 'POST', url: '/api/v1/ai/generations', payload: { ...request, id: randomUUID() } });
		expect(retained.statusCode).toBe(202);
		await settings.save({ activeProvider: null });
		expect((await app.inject({ method: 'GET', url: '/api/v1/ai' })).json()).toEqual({ configured: false });
		expect((await app.inject({ method: 'POST', url: '/api/v1/ai/content-selection', payload: request })).statusCode).toBe(503);
		expect((await app.inject({ method: 'POST', url: '/api/v1/ai/generations', payload: { ...request, id: randomUUID() } })).statusCode).toBe(503);
		expect(settings.status().profiles.find(profile => profile.provider === 'openai')?.hasKey).toBe(true);
		expect((await app.inject({ method: 'DELETE', url: '/api/v1/ai/settings/openai/key' })).statusCode).toBe(200);
		expect(settings.status().profiles.find(profile => profile.provider === 'openai')?.hasKey).toBe(false);
	}
	finally {
		await app.close();
		await rm(directory, { recursive: true, force: true });
		vi.unstubAllGlobals();
	}
});
