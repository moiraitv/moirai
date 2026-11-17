import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { validatorCompiler } from 'fastify-type-provider-zod';
import { afterEach, expect, it } from 'vitest';
import type { MediaServerProvider } from '@moirai/shared';
import { createDatabase } from '@server/db/index.js';
import { Repository } from '@server/repository/index.js';
import { DatabaseWriter, writerRepository } from '@server/repository/writer.js';
import { registerMediaServerRoutes } from '@server/routes/media-servers.js';
import { responseSerializerCompiler } from '@server/routes/contracts.js';
import { publicError } from '@server/routes/public-errors.js';

const ORIGINAL_TOKEN = 'SYNTHETIC_ORIGINAL_CREDENTIAL';
const REPLACEMENT_TOKEN = 'SYNTHETIC_REPLACEMENT_CREDENTIAL';
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) {
		await cleanup();
	}
});

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((complete) => {
		resolve = complete;
	});
	return { promise, resolve };
}

async function providerServer(provider: MediaServerProvider) {
	const credentials: string[] = [];
	let held: { entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> } | undefined;
	const server = createServer(async (request, response) => {
		credentials.push(String(request.headers['x-plex-token'] ?? request.headers['x-emby-token'] ?? request.headers.authorization ?? ''));
		const identity = request.url === '/identity' || request.url === '/System/Info';
		if (identity && held) {
			const pending = held;
			held = undefined;
			pending.entered.resolve();
			await pending.release.promise;
		}

		response.setHeader('Content-Type', 'application/json');
		response.end(JSON.stringify(provider === 'plex'
			? { MediaContainer: identity ? { machineIdentifier: 'audit-machine' } : { Directory: [] } }
			: identity ? { Id: 'audit-machine', ServerName: 'Audit' } : { Items: [] }));
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	cleanups.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
	return {
		origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
		credentials,
		holdNextProbe() {
			const entered = deferred();
			const release = deferred();
			held = { entered, release };
			cleanups.push(async () => release.resolve());
			return { entered: entered.promise, release: release.resolve };
		},
	};
}

async function fixture(provider: MediaServerProvider, allowInsecureTls = false) {
	const root = await mkdtemp(path.join(tmpdir(), 'moirai-credential-race-'));
	cleanups.push(() => rm(root, { recursive: true, force: true }));
	const database = createDatabase(path.join(root, 'database.sqlite'), path.resolve('drizzle'));
	cleanups.push(async () => {
		database.close();
	});
	const writer = new DatabaseWriter(database.sqlite.name);
	cleanups.push(() => writer.close());
	database.sqlite.pragma('query_only = ON');
	const repository = writerRepository(new Repository(database.db, true), writer);
	const previous = await providerServer(provider);
	const replacement = await providerServer(provider);
	const saved = await repository.mediaServers.createMediaServer({
		provider, name: 'Audit', baseUrl: previous.origin, accessToken: ORIGINAL_TOKEN,
		allowInsecureTls, playbackReportingEnabled: false, pathReplacements: [], clientIdentifier: 'audit-client',
	}, { serverKey: 'audit-machine', serverName: 'Audit', libraries: [] });
	const app = Fastify();
	cleanups.push(() => app.close());
	app.setValidatorCompiler(validatorCompiler);
	app.setSerializerCompiler(responseSerializerCompiler);
	await app.register(sensible);
	app.setErrorHandler((error, request, reply) => {
		const mapped = publicError(error, request.id);
		reply.status(mapped.statusCode).send(mapped.body);
	});
	registerMediaServerRoutes(app, { repository, scanner: {} as never });
	return { app, repository, previous, replacement, url: `/api/v1/media-servers/${saved.id}`, id: saved.id };
}

for (const provider of ['plex', 'jellyfin', 'emby'] as const) {
	it(`rejects a delayed ${provider} save before rebinding a replacement credential to the former address`, async () => {
		const { app, repository, previous, replacement, url, id } = await fixture(provider);
		const held = previous.holdNextProbe();
		const delayed = Promise.resolve(app.inject({ method: 'PATCH', url, payload: { name: 'Delayed rename' } }));
		await held.entered;

		const changed = await app.inject({ method: 'PATCH', url, payload: { baseUrl: replacement.origin, accessToken: REPLACEMENT_TOKEN } });
		expect(changed.statusCode).toBe(200);
		const acknowledged = await repository.mediaServers.getMediaServerConnection(id);
		held.release();
		const stale = await delayed;
		expect(stale.statusCode).toBe(409);
		expect(stale.body).not.toContain(ORIGINAL_TOKEN);
		expect(stale.body).not.toContain(REPLACEMENT_TOKEN);
		expect(await repository.mediaServers.getMediaServerConnection(id)).toEqual(acknowledged);

		const probe = await app.inject({ method: 'POST', url: `${url}/probe`, payload: {} });
		expect(probe.statusCode).toBe(200);
		expect(previous.credentials.some(value => value.includes(REPLACEMENT_TOKEN))).toBe(false);
		expect(replacement.credentials.some(value => value.includes(REPLACEMENT_TOKEN))).toBe(true);
	}, 15_000);

	it(`rejects a delayed ${provider} save that would restore an untrusted TLS exception`, async () => {
		const { app, repository, previous, url, id } = await fixture(provider, true);
		const held = previous.holdNextProbe();
		const delayed = Promise.resolve(app.inject({ method: 'PATCH', url, payload: { name: 'Delayed rename', allowInsecureTls: true } }));
		await held.entered;

		const changed = await app.inject({ method: 'PATCH', url, payload: { allowInsecureTls: false, accessToken: REPLACEMENT_TOKEN } });
		expect(changed.statusCode).toBe(200);
		const acknowledged = await repository.mediaServers.getMediaServerConnection(id);
		expect(acknowledged).toMatchObject({ accessToken: REPLACEMENT_TOKEN, allowInsecureTls: false });
		held.release();
		const stale = await delayed;
		expect(stale.statusCode).toBe(409);
		expect(stale.body).not.toContain(REPLACEMENT_TOKEN);
		expect(await repository.mediaServers.getMediaServerConnection(id)).toEqual(acknowledged);
	}, 15_000);

	it(`keeps an explicitly supplied ${provider} credential under the TLS policy that was probed`, async () => {
		const { app, repository, previous, url, id } = await fixture(provider);
		const held = previous.holdNextProbe();
		const pendingToken = 'SYNTHETIC_PENDING_STRICT_CREDENTIAL';
		const delayed = Promise.resolve(app.inject({ method: 'PATCH', url, payload: { accessToken: pendingToken } }));
		await held.entered;

		const changed = await app.inject({ method: 'PATCH', url, payload: { allowInsecureTls: true, accessToken: REPLACEMENT_TOKEN } });
		expect(changed.statusCode).toBe(200);
		expect(await repository.mediaServers.getMediaServerConnection(id)).toMatchObject({ accessToken: REPLACEMENT_TOKEN, allowInsecureTls: true });
		held.release();
		const completed = await delayed;
		expect(completed.statusCode).toBe(200);
		expect(completed.body).not.toContain(pendingToken);
		expect(await repository.mediaServers.getMediaServerConnection(id)).toMatchObject({
			baseUrl: previous.origin, accessToken: pendingToken, allowInsecureTls: false,
		});
	}, 15_000);

	it(`allows a concurrent ${provider} credential rotation when the destination and TLS policy stay safe`, async () => {
		const { app, repository, previous, url, id } = await fixture(provider);
		const held = previous.holdNextProbe();
		const delayed = Promise.resolve(app.inject({ method: 'PATCH', url, payload: { name: 'Delayed rename' } }));
		await held.entered;

		const changed = await app.inject({ method: 'PATCH', url, payload: { accessToken: REPLACEMENT_TOKEN } });
		expect(changed.statusCode).toBe(200);
		held.release();
		expect((await delayed).statusCode).toBe(200);
		expect(await repository.mediaServers.getMediaServerConnection(id)).toMatchObject({
			name: 'Delayed rename', baseUrl: previous.origin, accessToken: REPLACEMENT_TOKEN, allowInsecureTls: false,
		});
	}, 15_000);
}

it('normalizes retained destinations and rejects unsafe direct writer updates', async () => {
	const { repository, previous, replacement, id } = await fixture('plex');
	const inspection = { serverKey: 'audit-machine', serverName: 'Audit', libraries: [] };
	await expect(repository.mediaServers.updateMediaServer(id, { baseUrl: `${previous.origin}/` }, inspection)).resolves.toBeDefined();
	const acknowledged = await repository.mediaServers.getMediaServerConnection(id);
	for (const input of [{ baseUrl: replacement.origin }, { allowInsecureTls: true }]) {
		await expect(repository.mediaServers.updateMediaServer(id, input, inspection)).rejects.toMatchObject({ statusCode: 409 });
		expect(await repository.mediaServers.getMediaServerConnection(id)).toEqual(acknowledged);
	}
}, 15_000);
