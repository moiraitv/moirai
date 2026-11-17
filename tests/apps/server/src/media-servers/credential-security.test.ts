import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { validatorCompiler } from 'fastify-type-provider-zod';
import { afterEach, describe, expect, it } from 'vitest';
import { mediaServerCreateSchema } from '@moirai/shared';
import { createDatabase } from '@server/db/index.js';
import { Repository } from '@server/repository/index.js';
import { createMediaFetch } from '@server/media-servers/http.js';
import { PlexClient } from '@server/media-servers/plex-client.js';
import { JellyfinClient } from '@server/media-servers/jellyfin-client.js';
import { LogService } from '@server/operations/log-service.js';
import { registerMediaServerRoutes } from '@server/routes/media-servers.js';
import { responseSerializerCompiler } from '@server/routes/contracts.js';
import { publicError } from '@server/routes/public-errors.js';

const TOKEN = 'AUDIT_SYNTHETIC_TOKEN_LONG_ENOUGH';
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) {
		await close();
	}
});

async function fixture() {
	const seen: string[] = [];
	const upstream = createServer((request, response) => {
		seen.push(String(request.headers['x-plex-token']));
		response.setHeader('content-type', 'application/json');
		response.end(JSON.stringify(request.url?.endsWith('/identity')
			? { MediaContainer: { machineIdentifier: 'saved-machine' } }
			: { MediaContainer: { Directory: [] } }));
	});
	await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
	cleanup.push(() => new Promise<void>((resolve) => upstream.close(() => resolve())));
	const origin = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
	const database = createDatabase(':memory:', path.resolve('drizzle'));
	cleanup.push(async () => {
		database.close();
	});
	const repository = new Repository(database.db);
	const server = await repository.mediaServers.createMediaServer({
		provider: 'plex', name: 'Audit', baseUrl: `${origin}/original`, accessToken: TOKEN,
		allowInsecureTls: false, playbackReportingEnabled: false, pathReplacements: [], clientIdentifier: 'audit-client',
	}, { serverKey: 'saved-machine', serverName: 'Audit', libraries: [] });
	const app = Fastify();
	app.setValidatorCompiler(validatorCompiler);
	app.setSerializerCompiler(responseSerializerCompiler);
	await app.register(sensible);
	app.setErrorHandler((error, request, reply) => {
		const mapped = publicError(error, request.id);
		reply.status(mapped.statusCode).send(mapped.body);
	});
	registerMediaServerRoutes(app, { repository, scanner: {} as never });
	cleanup.push(() => app.close());
	return { app, repository, server, origin, seen };
}

describe('media credential boundaries', () => {
	it('probes saved credentials without changing the stored connection or revealing the token', async () => {
		const { app, server, repository, seen } = await fixture();
		const before = await repository.mediaServers.getMediaServerConnection(server.id);
		const response = await app.inject({ method: 'POST', url: `/api/v1/media-servers/${server.id}/probe`, payload: {} });
		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({ serverKey: 'saved-machine', libraries: [] });
		expect(response.body).not.toContain(TOKEN);
		expect(seen).toEqual([TOKEN, TOKEN]);
		expect(await repository.mediaServers.getMediaServerConnection(server.id)).toEqual(before);
	});

	it('rejects unsafe saved-server probes before contacting upstream', async () => {
		const { app, server, origin, seen } = await fixture();
		for (const payload of [{ baseUrl: origin }, { allowInsecureTls: true }, { provider: 'jellyfin' }, { accessToken: `${TOKEN}\ninvalid` }]) {
			const response = await app.inject({ method: 'POST', url: `/api/v1/media-servers/${server.id}/probe`, payload });
			expect(response.statusCode).toBe(400);
			expect(response.body).not.toContain(TOKEN);
		}
		expect(seen).toEqual([]);
	});

	it('tests a supplied credential at an edited address without persisting either change', async () => {
		const { app, server, repository, origin, seen } = await fixture();
		const before = await repository.mediaServers.getMediaServerConnection(server.id);
		const supplied = 'SYNTHETIC_PROBE_REPLACEMENT_TOKEN';
		const response = await app.inject({ method: 'POST', url: `/api/v1/media-servers/${server.id}/probe`, payload: { baseUrl: origin, accessToken: supplied } });
		expect(response.statusCode).toBe(200);
		expect(seen).toEqual([supplied, supplied]);
		expect(response.body).not.toContain(supplied);
		expect(await repository.mediaServers.getMediaServerConnection(server.id)).toEqual(before);
	});

	it('returns credential-safe failed probes and distinguishes a missing saved server', async () => {
		const { app, server, repository } = await fixture();
		const before = await repository.mediaServers.getMediaServerConnection(server.id);
		const failed = await app.inject({ method: 'POST', url: `/api/v1/media-servers/${server.id}/probe`, payload: { baseUrl: 'http://127.0.0.1:1', accessToken: TOKEN } });
		expect(failed.statusCode).toBe(400);
		expect(failed.body).not.toContain(TOKEN);
		expect(await repository.mediaServers.getMediaServerConnection(server.id)).toEqual(before);
		const missing = await app.inject({ method: 'POST', url: '/api/v1/media-servers/11111111-1111-4111-8111-111111111111/probe', payload: {} });
		expect(missing.statusCode).toBe(404);
	});

	it('never contacts a changed destination, changed provider, or weakened TLS without a supplied token', async () => {
		const { app, server, origin, seen } = await fixture();
		for (const payload of [{ baseUrl: origin }, { allowInsecureTls: true }, { provider: 'jellyfin' }]) {
			const response = await app.inject({ method: 'PATCH', url: `/api/v1/media-servers/${server.id}`, payload });
			expect(response.statusCode).toBe(400);
		}

		expect(seen).toEqual([]);
	});

	it('keeps a token on a name-only edit and uses only the new token at a changed address', async () => {
		const { app, server, origin, seen, repository } = await fixture();
		const rename = await app.inject({ method: 'PATCH', url: `/api/v1/media-servers/${server.id}`, payload: { name: 'Renamed' } });
		expect(rename.statusCode).toBe(200);
		expect(seen).toEqual([TOKEN, TOKEN]);
		seen.length = 0;
		const replacement = 'AUDIT_NEW_TOKEN_LONG_ENOUGH';
		const changed = await app.inject({ method: 'PATCH', url: `/api/v1/media-servers/${server.id}`, payload: { baseUrl: origin, accessToken: replacement } });
		expect(changed.statusCode).toBe(200);
		expect(seen).toEqual([replacement, replacement]);
		expect((await repository.mediaServers.getMediaServerConnection(server.id))?.accessToken).toBe(replacement);
	});

	it('rejects malformed user and provider tokens without putting their values in exceptions', async () => {
		const malformed = `${TOKEN}\nSECOND_LINE`;
		expect(mediaServerCreateSchema.safeParse({ provider: 'plex', name: 'Audit', baseUrl: 'https://audit.test', accessToken: malformed }).success).toBe(false);
		const connection = { provider: 'plex' as const, baseUrl: 'https://audit.test', clientIdentifier: 'audit-client', accessToken: TOKEN, allowInsecureTls: false };
		const response = { ok: true, status: 200, headers: { get: () => null }, body: null, arrayBuffer: async () => new ArrayBuffer(0), text: async () => JSON.stringify({ authToken: malformed, AccessToken: malformed }) };
		for (const promise of [PlexClient.pollPin(async () => response, 'audit-client', 1), JellyfinClient.signIn(async () => response, connection, 'user', 'password')]) {
			await expect(promise).rejects.toThrow(/invalid characters/);
		}

		const root = await mkdtemp(path.join(tmpdir(), 'moirai-credential-log-'));
		const logs = new LogService(root, 'error', 1_048_576, 1, 1_048_576);
		try {
			try {
				await createMediaFetch(false)('http://127.0.0.1:1', { headers: { 'X-Plex-Token': malformed } });
			}
			catch (error) {
				logs.logger.error({ err: error, accessToken: TOKEN }, 'Credential request failed');
			}
			await logs.close();
			const lines = (await Promise.all((await readdir(root)).map((file) => readFile(path.join(root, file), 'utf8')))).join('');
			expect(lines).not.toContain(TOKEN);
			expect(lines).not.toContain('SECOND_LINE');
		}
		finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it('hides legacy URL credentials in public projections but rejects their use', async () => {
		const { server, repository } = await fixture();
		const connection = await repository.mediaServers.getMediaServerConnection(server.id);
		const legacy = await repository.mediaServers.createMediaServer({ ...connection!, name: 'Legacy', baseUrl: `https://user:${TOKEN}@audit.test/plex?token=${TOKEN}#${TOKEN}`, accessToken: TOKEN }, { serverKey: 'legacy', serverName: 'Legacy', libraries: [] });
		expect(legacy.baseUrl).toBe('https://audit.test/plex');
		expect(legacy.baseUrl).not.toContain(TOKEN);
		const client = new PlexClient(async () => {
			throw new Error('Must not contact upstream');
		}, (await repository.mediaServers.getMediaServerConnection(legacy.id))!);
		await expect(client.inspect()).rejects.toThrow(/token field/);
	});
});
