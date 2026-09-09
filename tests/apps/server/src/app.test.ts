import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { RawData, WebSocket } from 'ws';
import type { InjectOptions } from 'light-my-request';
import sharp from 'sharp';
import { Temporal } from '@js-temporal/polyfill';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	channelCreateSchema,
	effectiveChannelTvgId,
	libraryCreateSchema,
	liveEventSchema,
	MAX_MEDIA_GENRE_RULES,
	PROGRAM_ITEM_ADDITION_CONFIRMATION_THRESHOLD,
	SECONDS_PER_SCHEDULING_DAY,
	type LiveEvent,
} from '@moirai/shared';
import { buildApp } from '@server/app.js';
import { hashToken } from '@server/auth/crypto.js';
import { AuthenticationRequestError, OIDC_SESSION_TTL_MS } from '@server/auth/service.js';
import { loadConfig } from '@server/config.js';
import { createDatabase } from '@server/db/index.js';
import { authenticationSessions } from '@server/db/schema.js';
import { Repository } from '@server/repository/index.js';

const transparentPng = await sharp({
	create: { width: 1, height: 1, channels: 4, background: '#00000000' },
})
	.png()
	.toBuffer();

/** Encode one deterministic multipart upload accepted by Fastify injection. */
function multipartVideo(filename: string, content: Buffer, fieldname = 'file'): {
	payload: Buffer;
	headers: Record<string, string>;
} {
	const boundary = `moirai-${randomUUID()}`;
	const payload = Buffer.concat([
		Buffer.from(
			`--${boundary}\r\nContent-Disposition: form-data; name="${fieldname}"; filename="${filename}"\r\n`
			+ 'Content-Type: video/mp4\r\n\r\n',
		),
		content,
		Buffer.from(`\r\n--${boundary}--\r\n`),
	]);
	return {
		payload,
		headers: {
			'content-type': `multipart/form-data; boundary=${boundary}`,
			'content-length': String(payload.length),
		},
	};
}

const cleanups: Array<() => Promise<void>> = [];
async function eventually<T>(read: () => Promise<T>, accept: (value: T) => boolean): Promise<T> {
	const deadline = Date.now() + 3_000;
	let value = await read();
	while (!accept(value) && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 20));
		value = await read();
	}
	return value;
}

function nextLiveEvent(
	socket: WebSocket,
	predicate: (event: LiveEvent) => boolean,
): Promise<LiveEvent> {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error('Timed out waiting for live event')), 10_000);
		const onMessage = (message: RawData) => {
			try {
				const event = liveEventSchema.parse(JSON.parse(message.toString()));
				if (!predicate(event)) {
					return;
				}

				clearTimeout(timeout);
				socket.off('message', onMessage);
				resolve(event);
			}
			catch (error) {
				clearTimeout(timeout);
				socket.off('message', onMessage);
				reject(error);
			}
		};
		socket.on('message', onMessage);
	});
}

async function fixture(options: {
	authenticated?: boolean;
	host?: string;
	managementUrl?: string;
	serveWeb?: boolean;
	sessionAgeMs?: number;
	trustedProxies?: string[];
} = {}) {
	const root = await mkdtemp(path.join(tmpdir(), 'moirai-api-'));
	const webDistDir = path.join(root, 'web');
	if (options.serveWeb) {
		await mkdir(path.join(webDistDir, 'help'), { recursive: true });
		await writeFile(path.join(webDistDir, 'index.html'), '<!doctype html><title>Moirai</title>');
		await writeFile(path.join(webDistDir, 'help/index.html'), '<!doctype html><title>User guide</title>');
		await writeFile(path.join(webDistDir, 'help/404.html'), '<!doctype html><title>Guide page missing</title>');
	}

	const config = loadConfig({
		dataDir: root,
		databasePath: path.join(root, 'test.sqlite'),
		migrationsDir: path.resolve('drizzle'),
		logLevel: 'silent',
		publicUrl: 'https://moirai.example.test',
		...(options.managementUrl ? { managementUrl: options.managementUrl } : {}),
		...(options.host ? { host: options.host } : {}),
		...(options.trustedProxies ? { trustedProxies: options.trustedProxies } : {}),
		...(options.serveWeb ? { webDistDir } : {}),
		playbackEnginePath: process.execPath,
		ffprobePath: path.resolve('tests/fixtures/fake-ffprobe.mjs'),
	});
	const database = createDatabase(config.databasePath, config.migrationsDir);
	const sessionToken = randomUUID();
	const csrfToken = `${randomUUID()}${randomUUID()}`;
	if (options.authenticated !== false) {
		const repository = new Repository(database.db);
		const nowMs = Date.now();
		const createdAt = new Date(nowMs - (options.sessionAgeMs ?? 0)).toISOString();
		const identity = await repository.authentication.claimInitialLocalIdentity({
			username: 'test-admin',
			usernameKey: 'test-admin',
			passwordHash: 'test-only',
			displayName: 'Test admin',
		}, createdAt);
		if (!identity) {
			throw new Error('Unable to initialize authenticated API fixture');
		}
		await database.db.insert(authenticationSessions).values({
			tokenHash: hashToken(sessionToken),
			identityId: identity.id,
			csrfToken,
			providerSessionId: null,
			providerLogoutHint: null,
			providerConfigurationHash: null,
			createdAt,
			lastSeenAt: createdAt,
			expiresAt: new Date(nowMs + 60_000).toISOString(),
		});
	}
	const built = await buildApp(config, database.db);
	const app = options.authenticated === false ? built.app : new Proxy(built.app, {
		get(target, property) {
			if (property === 'inject') {
				return (input: string | Record<string, unknown>) => {
					const request: InjectOptions = typeof input === 'string'
						? { url: input }
						: input as unknown as InjectOptions;
					const headers = {
						cookie: `moirai_session=${sessionToken}`,
						'x-moirai-csrf': csrfToken,
						...request.headers,
					};
					return target.inject({ ...request, headers });
				};
			}
			if (property === 'injectWS') {
				return (pathValue: string) => target.injectWS(pathValue, {
					headers: { cookie: `moirai_session=${sessionToken}` },
				});
			}

			const value = Reflect.get(target, property);
			return typeof value === 'function' ? value.bind(target) : value;
		},
	}) as typeof built.app;
	cleanups.push(async () => {
		await built.services.scanner.close();
		await built.app.close();
		database.close();
		await rm(root, { recursive: true, force: true });
	});
	return { ...built, app, rawApp: built.app, database, root, sessionToken };
}
afterEach(async () => {
	vi.useRealTimers();
	await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('API', () => {
	it('protects management data while leaving health and IPTV delivery public', async () => {
		const { app } = await fixture({ authenticated: false });
		expect([200, 503]).toContain(
			(await app.inject({ url: '/api/v1/health/ready' })).statusCode,
		);
		expect((await app.inject({ url: '/iptv/channels.m3u' })).statusCode).toBe(200);
		expect((await app.inject({ url: '/epg.xml' })).statusCode).toBe(200);
		expect((await app.inject({ url: `/api/v1/artwork/items/${randomUUID()}` })).statusCode)
			.toBe(404);
		expect((await app.inject({ url: `/api/v1/channels/${randomUUID()}/logo` })).statusCode)
			.toBe(404);

		const playback = await app.inject({ url: '/api/v1/playback/status' });
		expect(playback.statusCode).toBe(401);
		expect(playback.json()).toMatchObject({ code: 'authentication_required' });
		const capabilities = await app.inject({ url: '/api/v1/capabilities' });
		expect(capabilities.statusCode).toBe(401);
		expect(capabilities.json()).toMatchObject({ code: 'authentication_required' });
	});

	it('serves bundled help publicly without falling through to the management SPA', async () => {
		const { rawApp } = await fixture({ authenticated: false, serveWeb: true });

		const guide = await rawApp.inject('/help/');
		const missingGuidePage = await rawApp.inject('/help/not-a-page.html');
		expect(guide.statusCode).toBe(200);
		expect(guide.payload).toContain('<title>User guide</title>');
		expect(missingGuidePage.statusCode).toBe(404);
		expect(missingGuidePage.payload).toContain('<title>Guide page missing</title>');
		expect(missingGuidePage.payload).not.toContain('<title>Moirai</title>');
	});

	it('protects canonically matched API routes with an encoded prefix', async () => {
		const { app } = await fixture({ authenticated: false });

		const protectedResponse = await app.inject({ url: '/%61pi/v1/playback/status' });
		const publicResponse = await app.inject({ url: '/%61pi/v1/health/live' });

		expect(protectedResponse.statusCode).toBe(401);
		expect(protectedResponse.json()).toMatchObject({ code: 'authentication_required' });
		expect(publicResponse.statusCode).toBe(200);
	});

	it('denies framing and prevents authentication-sensitive responses from being cached', async () => {
		const { app, rawApp } = await fixture({ serveWeb: true });
		const protectedResponse = await app.inject('/api/v1/playback/settings');
		const rejectedResponse = await rawApp.inject('/api/v1/playback/settings');
		const publicResponse = await rawApp.inject('/api/v1/health/live');
		const browserResponse = await rawApp.inject('/login');

		for (const response of [
			protectedResponse,
			rejectedResponse,
			publicResponse,
			browserResponse,
		]) {
			expect(response.headers['content-security-policy']).toBe("frame-ancestors 'none'");
			expect(response.headers['x-frame-options']).toBe('DENY');
		}
		expect(browserResponse.statusCode).toBe(200);
		expect(protectedResponse.headers['cache-control']).toBe('private, no-store');
		expect(rejectedResponse.headers['cache-control']).toBe('private, no-store');
		expect(publicResponse.headers['cache-control']).toBeUndefined();
	});

	it('omits cross-origin grants while rejecting unsafe requests from a foreign origin', async () => {
		const { app } = await fixture();
		const read = await app.inject({
			url: '/api/v1/auth/session',
			headers: { origin: 'https://attacker.example.test' },
		});
		expect(read.statusCode).toBe(200);
		expect(read.headers['access-control-allow-origin']).toBeUndefined();

		const write = await app.inject({
			method: 'PUT',
			url: '/api/v1/playback/settings',
			headers: { origin: 'https://attacker.example.test' },
			payload: { maxActiveSessions: 5 },
		});
		expect(write.statusCode).toBe(403);
		expect(write.json()).toMatchObject({ code: 'csrf_rejected' });
	});

	it('allows development requests between supported loopback host spellings', async () => {
		const { app } = await fixture({ host: 'localhost' });
		const response = await app.inject({
			method: 'PUT',
			url: '/api/v1/playback/settings',
			headers: { origin: 'http://127.0.0.2:5173' },
			payload: { maxActiveSessions: 5 },
		});

		expect(response.statusCode).toBe(200);
	});

	it('allows protected browser requests from the configured management origin', async () => {
		const { app } = await fixture({
			host: '0.0.0.0',
			managementUrl: 'https://moirai.example.test:5173',
		});
		const response = await app.inject({
			method: 'PUT',
			url: '/api/v1/playback/settings',
			headers: { origin: 'https://moirai.example.test:5173' },
			payload: { maxActiveSessions: 5 },
		});

		expect(response.statusCode).toBe(200);
	});

	it('skips session persistence work for public resources but resolves the session endpoint', async () => {
		const { app, services } = await fixture();
		const resolveSession = vi.spyOn(services.authentication, 'resolveRequestSession');

		expect((await app.inject({
			url: `/api/v1/artwork/items/${randomUUID()}`,
		})).statusCode).toBe(404);
		expect(resolveSession).not.toHaveBeenCalled();

		const session = await app.inject('/api/v1/auth/session');
		expect(session.json()).toMatchObject({
			status: 'authenticated',
		});
		expect(session.headers['set-cookie']).toBeUndefined();
		expect(resolveSession).toHaveBeenCalledTimes(1);
	});

	it('refreshes the stable browser cookie when active session lifetime extends', async () => {
		const { app, services, sessionToken } = await fixture({
			sessionAgeMs: 25 * 60 * 60 * 1_000,
		});
		const response = await app.inject('/api/v1/auth/session');
		const cookie = String(response.headers['set-cookie']);
		const refreshedToken = /^moirai_session=([^;]+)/u.exec(cookie)?.[1];

		expect(response.statusCode).toBe(200);
		expect(refreshedToken).toBe(sessionToken);
		expect(cookie).toContain('Max-Age=2592000');
		expect(await services.authentication.resolveSession(sessionToken)).not.toBeNull();

		const overlapping = await app.inject('/api/v1/auth/session');
		expect(overlapping.statusCode).toBe(200);
		expect(overlapping.json()).toMatchObject({ status: 'authenticated' });
		expect(overlapping.headers['set-cookie']).toBeUndefined();
	});

	it('suppresses a renewal cookie that was superseded before the response', async () => {
		const { app, services } = await fixture({
			sessionAgeMs: 25 * 60 * 60 * 1_000,
		});
		vi.spyOn(services.authentication, 'sessionTokenIsActive').mockResolvedValue(false);

		const response = await app.inject('/api/v1/auth/session');

		expect(response.statusCode).toBe(200);
		expect(response.headers['set-cookie']).toBeUndefined();
	});

	it('rejects an overlapping predecessor cookie after credential rotation', async () => {
		const { rawApp, database } = await fixture({ authenticated: false });
		const setup = await rawApp.inject({
			method: 'POST',
			url: '/api/v1/auth/setup',
			payload: {
				username: 'Local Admin',
				password: 'a sufficiently long password',
			},
		});
		const predecessorCookie = String(setup.headers['set-cookie']).split(';', 1)[0];
		const csrfToken = setup.json().csrfToken as string;
		const staleActivity = new Date(Date.now() - 25 * 60 * 60 * 1_000).toISOString();
		database.sqlite.prepare(
			'UPDATE authentication_sessions SET last_seen_at = ?',
		).run(staleActivity);
		const rotation = await rawApp.inject({
			method: 'PUT',
			url: '/api/v1/auth/local-credentials',
			headers: {
				cookie: predecessorCookie,
				'x-moirai-csrf': csrfToken,
			},
			payload: {
				username: 'Local Admin',
				password: 'a replacement sufficiently long password',
				currentPassword: 'a sufficiently long password',
			},
		});
		const overlapping = await rawApp.inject({
			url: '/api/v1/auth/session',
			headers: { cookie: predecessorCookie },
		});

		expect(rotation.statusCode).toBe(200);
		expect(overlapping.statusCode).toBe(200);
		expect(overlapping.json()).toMatchObject({ status: 'anonymous' });
		expect(overlapping.headers['set-cookie']).toBeUndefined();
	});

	it('binds the Logto callback to a short-lived initiating-browser cookie', async () => {
		const { rawApp, services } = await fixture({
			authenticated: false,
			managementUrl: 'https://moirai.example.test:5173',
		});
		vi.spyOn(services.authentication, 'beginLogto').mockResolvedValue({
			url: 'https://tenant.logto.app/oidc/auth?state=provider-state',
			bindingToken: 'browser-binding',
		});
		const start = await rawApp.inject('/api/v1/auth/logto/start');
		const bindingCookie = String(start.headers['set-cookie']);
		expect(start.headers['cache-control']).toBe('private, no-store');
		expect(bindingCookie).toContain('moirai_oidc_binding=browser-binding');
		expect(bindingCookie).toContain('HttpOnly');
		expect(bindingCookie).toContain('SameSite=Lax');
		expect(bindingCookie).toContain('Path=/api/v1/auth/logto/callback');

		const complete = vi.spyOn(services.authentication, 'completeLogto')
			.mockRejectedValue(new Error('Stop after verifying route binding'));
		const callback = await rawApp.inject({
			url: '/api/v1/auth/logto/callback?state=provider-state&code=provider-code',
			headers: { cookie: 'moirai_oidc_binding=browser-binding' },
		});
		expect(callback.statusCode).toBe(302);
		expect(complete).toHaveBeenCalledWith(
			expect.stringContaining('state=provider-state'),
			'provider-state',
			'browser-binding',
		);
		expect(callback.headers.location).toBe(
			'https://moirai.example.test:5173/login?error=oidc',
		);
		expect(callback.headers['cache-control']).toBe('private, no-store');

		const oversizedLogout = await rawApp.inject({
			method: 'POST',
			url: '/api/v1/auth/logto/backchannel-logout',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			payload: `logout_token=${'a'.repeat(35 * 1_024)}`,
		});
		expect(oversizedLogout.statusCode).toBe(413);
	});

	it('returns a successful Logto callback to the browser management origin', async () => {
		const { rawApp, services } = await fixture({
			authenticated: false,
			managementUrl: 'https://moirai.example.test:5173',
		});
		const issued = await services.authentication.setupLocal({
			username: 'Local Admin',
			password: 'a sufficiently long password',
		}, '127.0.0.1');
		issued.record.expiresAt = new Date(Date.now() + OIDC_SESSION_TTL_MS).toISOString();
		vi.spyOn(services.authentication, 'completeLogto').mockResolvedValue({
			session: issued,
			returnTo: '/channels',
		});

		const callback = await rawApp.inject({
			url: '/api/v1/auth/logto/callback?state=provider-state&code=provider-code',
			headers: { cookie: 'moirai_oidc_binding=browser-binding' },
		});

		expect(callback.statusCode).toBe(302);
		expect(callback.headers.location).toBe('https://moirai.example.test:5173/channels');
		expect(callback.headers['cache-control']).toBe('private, no-store');
		expect(String(callback.headers['set-cookie'])).toContain('moirai_session=');
		expect(String(callback.headers['set-cookie'])).toContain('Max-Age=86400');
	});

	it('rejects usernames that exceed the contract after compatibility normalization', async () => {
		const { app } = await fixture({ authenticated: false });
		const rejected = await app.inject({
			method: 'POST',
			url: '/api/v1/auth/setup',
			payload: {
				username: '\uFDFA'.repeat(64),
				password: 'a sufficiently long password',
			},
		});
		expect(rejected.statusCode).toBe(400);
		expect(rejected.json()).toMatchObject({ code: 'validation_error' });

		const accepted = await app.inject({
			method: 'POST',
			url: '/api/v1/auth/setup',
			payload: {
				username: 'Local Admin',
				password: 'a sufficiently long password',
			},
		});
		expect(accepted.statusCode).toBe(201);
	});

	it('uses a forwarded client address only when its immediate proxy is trusted', async () => {
		const { rawApp, services } = await fixture({
			authenticated: false,
			trustedProxies: ['10.0.0.10'],
		});
		const login = vi.spyOn(services.authentication, 'loginLocal').mockRejectedValue(
			new AuthenticationRequestError('Invalid username or password', 401, 'invalid_credentials'),
		);

		const response = await rawApp.inject({
			method: 'POST',
			url: '/api/v1/auth/login',
			remoteAddress: '10.0.0.10',
			headers: { 'x-forwarded-for': '198.51.100.7' },
			payload: { username: 'Administrator', password: 'a long local password' },
		});
		expect(response.statusCode).toBe(401);
		expect(login).toHaveBeenCalledWith(
			{ username: 'Administrator', password: 'a long local password' },
			'198.51.100.7',
		);

		login.mockClear();
		await rawApp.inject({
			method: 'POST',
			url: '/api/v1/auth/login',
			remoteAddress: '10.0.0.11',
			headers: { 'x-forwarded-for': '198.51.100.8' },
			payload: { username: 'Administrator', password: 'a long local password' },
		});
		expect(login).toHaveBeenCalledWith(
			{ username: 'Administrator', password: 'a long local password' },
			'10.0.0.11',
		);
	});

	it('initializes local access once and enforces CSRF on management writes', async () => {
		const { app } = await fixture({ authenticated: false });
		const initial = await app.inject({ url: '/api/v1/auth/session' });
		expect(initial.json()).toMatchObject({
			status: 'uninitialized',
			methods: { local: false, logto: false },
		});

		const setup = await app.inject({
			method: 'POST',
			url: '/api/v1/auth/setup',
			payload: { username: 'Administrator', password: 'a long local password' },
		});
		expect(setup.statusCode).toBe(201);
		expect(setup.json()).toMatchObject({
			status: 'authenticated',
			localUsername: 'Administrator',
		});
		const cookie = setup.headers['set-cookie'];
		expect(cookie).toContain('HttpOnly');
		expect(cookie).toContain('SameSite=Lax');
		expect(setup.headers['cache-control']).toBe('private, no-store');
		const cookieHeader = String(cookie).split(';', 1)[0];
		const csrfToken = setup.json().csrfToken as string;

		const repeated = await app.inject({
			method: 'POST',
			url: '/api/v1/auth/setup',
			payload: { username: 'Other', password: 'another long password' },
		});
		expect(repeated.statusCode).toBe(409);
		const anonymousState = await app.inject({ url: '/api/v1/auth/session' });
		expect(anonymousState.json()).toMatchObject({
			status: 'anonymous',
			localUsername: null,
		});

		const missingCsrf = await app.inject({
			method: 'PUT',
			url: '/api/v1/playback/settings',
			headers: { cookie: cookieHeader },
			payload: { maxActiveSessions: 4 },
		});
		expect(missingCsrf.statusCode).toBe(403);
		expect(missingCsrf.json()).toMatchObject({ code: 'csrf_rejected' });

		const authenticated = await app.inject({
			method: 'PUT',
			url: '/api/v1/playback/settings',
			headers: { cookie: cookieHeader, 'x-moirai-csrf': csrfToken },
			payload: { maxActiveSessions: 5 },
		});
		expect(authenticated.statusCode).toBe(200);
	});

	it('returns safe snapshot details for channel-scoped guide segments', async () => {
		const { app, services } = await fixture();
		const channelId = randomUUID();
		const segmentId = randomUUID();
		const mediaId = randomUUID();
		const libraryId = randomUUID();
		vi.spyOn(services.repository, 'getMaterializedTimelineSegment').mockImplementation(
			async (requestedChannelId, requestedSegmentId) =>
				requestedChannelId === channelId && requestedSegmentId === segmentId
					? {
						segment: {
							id: segmentId,
							role: 'primary',
							channelId,
							scheduleLayerId: null,
							templateId: randomUUID(),
							slotId: randomUUID(),
							programId: null,
							mediaItemId: mediaId,
							title: 'Committed movie',
							playbackPath: '/private/media/movie.mkv',
							start: '2026-08-24T19:00:00Z',
							finish: '2026-08-24T21:00:00Z',
							sourceStartSeconds: 0,
							sourceFinishSeconds: null,
							truncated: false,
						},
						mediaSnapshot: {
							id: mediaId,
							libraryId,
							groupId: null,
							kind: 'movie',
							title: 'Committed movie',
							sortTitle: 'committed movie',
							playbackPath: '/private/media/movie.mkv',
							durationSeconds: 7_200,
							seasonNumber: null,
							episodeNumber: null,
							genres: ['drama'],
							genreNames: ['Drama'],
							plot: 'A committed snapshot.',
							year: 2026,
							artworkUrl: `/api/v1/artwork/items/${mediaId}?v=poster`,
							availability: 'available',
						},
						stateDelta: [],
					}
					: null,
		);
		const response = await app.inject({
			url: `/api/v1/channels/${channelId}/guide-segments/${segmentId}`,
		});
		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({
			media: { id: mediaId, title: 'Committed movie' },
			catalogItemPresent: false,
		});
		expect(response.json().segment).not.toHaveProperty('playbackPath');
		expect(response.payload).not.toContain('/private/media');
		const wrongChannel = await app.inject({
			url: `/api/v1/channels/${randomUUID()}/guide-segments/${segmentId}`,
		});
		expect(wrongChannel.statusCode).toBe(404);
	});

	it('returns a generic response for unexpected server failures', async () => {
		const { app } = await fixture();
		app.get('/api/v1/test/internal-failure', async () => {
			throw new Error('SQLite failed at /Volumes/Private/moirai.sqlite');
		});
		const response = await app.inject({ url: '/api/v1/test/internal-failure' });
		expect(response.statusCode).toBe(500);
		expect(response.json()).toMatchObject({
			code: 'internal_error',
			message: 'An unexpected server error occurred',
			requestId: expect.any(String),
		});
		expect(response.payload).not.toContain('/Volumes/Private');
	});

	it('invalidates EPG documents only for guide-affecting server events', async () => {
		const { services } = await fixture();
		const invalidate = vi.spyOn(services.epg, 'invalidate');
		services.events.publish({
			type: 'playback.changed',
			data: { channelId: null, reason: 'settings-changed' },
		});
		expect(invalidate).not.toHaveBeenCalled();
		services.events.publish({
			type: 'channel.changed',
			data: { channelId: randomUUID(), change: 'updated' },
		});
		expect(invalidate).toHaveBeenCalledOnce();
	});

	it('reports health and capabilities', async () => {
		const { app, services } = await fixture();
		expect((await app.inject({ url: '/api/v1/health' })).json()).toEqual({ status: 'ok' });
		expect((await app.inject({ url: '/api/v1/health/live' })).json()).toEqual({ status: 'ok' });
		await services.scanner.start();
		const ready = await app.inject({ url: '/api/v1/health/ready' });
		expect(ready.statusCode).toBe(200);
		expect(ready.json()).toMatchObject({ status: 'ready' });
		const capabilities = (await app.inject({ url: '/api/v1/capabilities' })).json();
		expect(capabilities.sourceTypes).toContain('on-disk');
		expect(capabilities.timeZone).toBeTruthy();
	});

	it('keeps liveness available while readiness reports an unusable database', async () => {
		const { app, services } = await fixture();
		await app.ready();
		await services.scanner.start();
		vi.spyOn(services.repository, 'checkDatabase').mockImplementation(() => {
			throw new Error('database unavailable');
		});

		expect((await app.inject({ url: '/api/v1/health/live' })).statusCode).toBe(200);
		const readiness = await app.inject({ url: '/api/v1/health/ready' });
		expect(readiness.statusCode).toBe(503);
		expect(readiness.json()).toMatchObject({
			status: 'degraded',
			checks: expect.arrayContaining([
				expect.objectContaining({ name: 'database', status: 'degraded', essential: true }),
			]),
		});
	});

	it('reports failed materialization as an essential readiness failure', async () => {
		const { app, services } = await fixture();
		await app.ready();
		await services.scanner.start();
		vi.spyOn(services.repository, 'listTimelineMaterializationStatuses').mockResolvedValue([
			{
				channelId: randomUUID(),
				health: 'failed',
				windowStart: null,
				windowEnd: null,
				pendingSince: null,
				applyAfter: null,
				lastError: 'generation failed',
				committedAt: null,
			},
		]);

		const readiness = await app.inject({ url: '/api/v1/health/ready' });
		expect(readiness.statusCode).toBe(503);
		expect(readiness.json()).toMatchObject({
			status: 'degraded',
			checks: expect.arrayContaining([
				expect.objectContaining({ name: 'timeline', status: 'degraded', essential: true }),
			]),
		});
	});

	it('serves bounded log browsing and rejects invalid cursors safely', async () => {
		const { app } = await fixture();
		const page = await app.inject({ url: '/api/v1/logs?limit=20&search=scan' });
		expect(page.statusCode).toBe(200);
		expect(page.json()).toMatchObject({ entries: [], nextCursor: null });
		const invalid = await app.inject({ url: '/api/v1/logs?cursor=forged' });
		expect(invalid.statusCode).toBe(400);
		expect(invalid.json()).toMatchObject({ code: 'request_failed' });
	});

	it('serves a cache-aware public XMLTV feed and invalidates it after channel changes', async () => {
		const { app } = await fixture();
		const empty = await app.inject({ url: '/epg.xml' });
		expect(empty.statusCode).toBe(200);
		expect(empty.headers['content-type']).toMatch(/^application\/xml/);
		expect(empty.payload).toContain('<tv generator-info-name="Moirai">');
		const initialEtag = empty.headers.etag;
		expect(initialEtag).toBeTruthy();

		const created = await app.inject({
			method: 'POST',
			url: '/api/v1/channels',
			payload: channelCreateSchema.parse({ number: '17', name: 'Guide Channel' }),
		});
		expect(created.statusCode).toBe(201);
		const populated = await app.inject({ url: '/epg.xml' });
		expect(populated.statusCode).toBe(200);
		expect(populated.headers.etag).not.toBe(initialEtag);
		expect(populated.payload).toContain(
			`<channel id="${effectiveChannelTvgId(created.json())}">`,
		);
		expect(populated.payload).toContain('<title>No programming</title>');

		const unchanged = await app.inject({
			url: '/epg.xml',
			headers: { 'if-none-match': populated.headers.etag! },
		});
		expect(unchanged.statusCode).toBe(304);
		expect(unchanged.headers.etag).toBe(populated.headers.etag);
		expect(unchanged.payload).toBe('');
	});

	it('validates and serves bounded program source picker requests', async () => {
		const { app } = await fixture();
		const libraryId = randomUUID();
		const invalid = await app.inject({
			url: `/api/v1/libraries/${libraryId}/media-source-options?target=items&pageSize=101`,
		});
		expect(invalid.statusCode).toBe(400);

		const valid = await app.inject({
			url: `/api/v1/libraries/${libraryId}/media-source-options?target=groups&page=1&pageSize=25`,
		});
		expect(valid.statusCode).toBe(200);
		expect(valid.json()).toMatchObject({
			entries: [],
			pagination: { page: 1, pageSize: 25, totalEntries: 0, totalPages: 1 },
		});
	});

	it('passes deduplicated Match all selections to contextual genre facets', async () => {
		const { app, services } = await fixture();
		const libraryId = randomUUID();
		const listMediaGenres = vi.spyOn(services.repository, 'listMediaGenres').mockResolvedValue([
			{ key: 'drama', name: 'Drama', count: 4, excludeCount: 7 },
		]);

		const response = await app.inject({
			url: `/api/v1/libraries/${libraryId}/media-genres?genreMatch=all&genres=drama&genres=science-fiction&genres=drama&excludedGenres=comedy`,
		});

		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual([
			{ key: 'drama', name: 'Drama', count: 4, excludeCount: 7 },
		]);
		expect(listMediaGenres).toHaveBeenCalledWith(libraryId, {
			genres: ['drama', 'science-fiction'],
			excludedGenres: ['comedy'],
		});

		const contradictory = await app.inject({
			url: `/api/v1/libraries/${libraryId}/media-genres?genreMatch=all&genres=drama&excludedGenres=drama`,
		});
		expect(contradictory.statusCode).toBe(400);

		const unsupported = await app.inject({
			url: `/api/v1/libraries/${libraryId}/media-genres?genreMatch=any&excludedGenres=drama`,
		});
		expect(unsupported.statusCode).toBe(400);
		const contradictoryBrowse = await app.inject({
			url: `/api/v1/libraries/${libraryId}/media?genres=drama&excludedGenres=drama`,
		});
		expect(contradictoryBrowse.statusCode).toBe(400);

		const browseMedia = vi.spyOn(services.repository, 'browseMedia');
		const defaultBrowse = await app.inject({
			url: `/api/v1/libraries/${libraryId}/media`,
		});
		expect(defaultBrowse.statusCode).toBe(200);
		expect(browseMedia).toHaveBeenCalledWith(libraryId, expect.objectContaining({
			genres: [],
			excludedGenres: [],
			genreMatch: 'all',
			minimumRating: null,
			minimumUserRating: null,
		}));
		const ratedBrowse = await app.inject({
			url: `/api/v1/libraries/${libraryId}/media?minimumRating=7.5&minimumUserRating=8`,
		});
		expect(ratedBrowse.statusCode).toBe(200);
		expect(browseMedia).toHaveBeenCalledWith(libraryId, expect.objectContaining({
			minimumRating: 7.5,
			minimumUserRating: 8,
		}));
		const emptyRating = await app.inject({
			url: `/api/v1/libraries/${libraryId}/media?minimumRating=`,
		});
		expect(emptyRating.statusCode).toBe(200);
		expect(browseMedia).toHaveBeenLastCalledWith(libraryId, expect.objectContaining({
			minimumRating: null,
		}));
		const invalidRating = await app.inject({
			url: `/api/v1/libraries/${libraryId}/media?minimumRating=10.1`,
		});
		expect(invalidRating.statusCode).toBe(400);
	});

	it('rejects genre queries that exceed the shared rule limit', async () => {
		const { app } = await fixture();
		const libraryId = randomUUID();
		const params = new URLSearchParams({ genreMatch: 'all' });
		for (let index = 0; index < MAX_MEDIA_GENRE_RULES; index += 1) {
			params.append('genres', `included-${index}`);
		}
		params.append('excludedGenres', 'one-too-many');

		const response = await app.inject({
			url: `/api/v1/libraries/${libraryId}/media-genres?${params.toString()}`,
		});

		expect(response.statusCode).toBe(400);
	});

	it('streams versioned events over the shared WebSocket endpoint', async () => {
		const { app, services } = await fixture();
		await app.ready();
		const socket = await app.injectWS('/api/v1/events');
		const eventPromise = nextLiveEvent(socket, (event) => event.type === 'library.changed');
		services.events.publish({
			type: 'library.changed',
			data: {
				libraryId: '2be7a2b9-81b5-4a72-a3d8-ad4e6394dd25',
				change: 'watcher-status',
				watcherStatus: 'ready',
			},
		});
		const changed = await eventPromise;
		expect(changed).toMatchObject({
			protocolVersion: 1,
			type: 'library.changed',
			data: { change: 'watcher-status', watcherStatus: 'ready' },
		});
		socket.close();
	});

	it('rejects WebSocket upgrades from a foreign browser origin', async () => {
		const { rawApp, sessionToken } = await fixture();
		const response = await rawApp.inject({
			url: '/api/v1/events',
			headers: {
				connection: 'upgrade',
				upgrade: 'websocket',
				origin: 'https://attacker.example.test',
				cookie: `moirai_session=${sessionToken}`,
			},
		});

		expect(response.statusCode).toBe(403);
		expect(response.json()).toMatchObject({ code: 'csrf_rejected' });
	});

	it('closes an established WebSocket when its authentication session is revoked', async () => {
		const { app, services, sessionToken } = await fixture();
		await app.ready();
		const socket = await app.injectWS('/api/v1/events');
		const closed = new Promise<{ code: number; reason: string }>((resolve) => {
			socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() }));
		});
		const sessionRecord = await services.authentication.resolveSession(sessionToken);
		if (!sessionRecord) {
			throw new Error('Expected authenticated WebSocket fixture session');
		}

		await services.authentication.logout(sessionRecord);

		await expect(closed).resolves.toEqual({
			code: 1008,
			reason: 'Authentication session ended',
		});
	});

	it('serves the prior cached version when changed artwork is temporarily unavailable', async () => {
		const { app, services, root } = await fixture();
		const mediaRoot = path.join(root, 'media');
		await mkdir(mediaRoot);
		await writeFile(path.join(mediaRoot, 'Film.mkv'), 'video');
		await writeFile(path.join(mediaRoot, 'Film.nfo'), '<movie><title>Film</title></movie>');
		await writeFile(path.join(mediaRoot, 'poster.png'), transparentPng);
		const library = await services.repository.createLibrary(
			libraryCreateSchema.parse({
				name: 'Movies',
				typeKey: 'movies',
				sourceType: 'on-disk',
				sourceConfig: { scanRoot: mediaRoot, playbackRoot: null },
			}),
		);
		await services.scanner.scan(library.id, 'manual');
		const media = (await app.inject({ url: `/api/v1/libraries/${library.id}/media` })).json();
		const artworkUrl = media.items[0].artworkUrl as string;
		const first = await app.inject({ url: artworkUrl });
		expect(first.statusCode).toBe(200);
		expect(first.headers['x-moirai-artwork-cache']).toBe('miss');
		expect(first.headers['cache-control']).toContain('immutable');
		expect(first.headers['content-type']).toMatch(/^image\/jpeg/);
		const cachedPayload = first.rawPayload;

		await writeFile(
			path.join(mediaRoot, 'poster.png'),
			Buffer.concat([transparentPng, Buffer.from('changed')]),
		);
		await services.scanner.scan(library.id, 'manual');
		const changedMedia = (
			await app.inject({ url: `/api/v1/libraries/${library.id}/media` })
		).json();
		const changedArtworkUrl = changedMedia.items[0].artworkUrl as string;
		expect(changedArtworkUrl).not.toBe(artworkUrl);

		await rm(mediaRoot, { recursive: true, force: true });
		const cached = await app.inject({ url: changedArtworkUrl });
		expect(cached.statusCode).toBe(200);
		expect(cached.headers['x-moirai-artwork-cache']).toBe('stale');
		expect(cached.rawPayload).toEqual(cachedPayload);

		const coldVariant = new URL(changedArtworkUrl, 'https://moirai.test');
		coldVariant.searchParams.set('variant', 'detail');
		coldVariant.searchParams.set('dpr', '3');
		const unavailable = await app.inject({ url: `${coldVariant.pathname}${coldVariant.search}` });
		expect(unavailable.statusCode).toBe(503);
		expect(unavailable.headers['retry-after']).toBe('5');
		expect(unavailable.json()).toMatchObject({ code: 'service_unavailable' });
		expect(unavailable.payload).not.toContain(mediaRoot);
	});

	it('serves media details and browser-seekable byte ranges without exposing the scan root', async () => {
		const { app, services, root } = await fixture();
		const mediaRoot = path.join(root, 'preview-media');
		await mkdir(mediaRoot);
		const mediaBytes = Buffer.from('0123456789');
		await writeFile(path.join(mediaRoot, 'Preview.mp4'), mediaBytes);
		await writeFile(
			path.join(mediaRoot, 'Preview.nfo'),
			`<movie>
		<title>Preview Film</title><runtime>98</runtime><rating>7.2</rating><mpaa>PG-13</mpaa>
		<plot>A concise preview summary.</plot><genre>Adventure</genre><genre>Drama</genre>
		<actor><name>Second Actor</name><order>2</order></actor>
		<actor><name>First Actor</name><sortorder>1</sortorder></actor>
		<actor><name>Third Actor</name><order>3</order></actor>
		<actor><name>Unbilled Actor</name></actor>
		<credits>Example Writer</credits><studio>Example Studio</studio><country>Example Country</country>
        <fileinfo><streamdetails><video><width>1920</width><height>1080</height></video></streamdetails></fileinfo>
      </movie>`,
		);
		const library = await services.repository.createLibrary(
			libraryCreateSchema.parse({
				name: 'Preview Movies',
				typeKey: 'movies',
				sourceType: 'on-disk',
				sourceConfig: { scanRoot: mediaRoot, playbackRoot: '/media' },
				watcherEnabled: false,
			}),
		);
		await services.scanner.scan(library.id, 'manual');
		const media = (await app.inject({ url: `/api/v1/libraries/${library.id}/media` })).json();
		const itemId = media.items[0].id as string;
		const libraryPreviews = await app.inject({ url: '/api/v1/libraries/content-previews' });
		expect(libraryPreviews.statusCode).toBe(200);
		expect(libraryPreviews.json()).toEqual(expect.arrayContaining([
			{
				libraryId: library.id,
				items: [expect.objectContaining({
					id: itemId,
					title: 'Preview Film',
					availability: 'available',
				})],
			},
		]));
		const detailResponse = await app.inject({ url: `/api/v1/media/${itemId}` });
		expect(detailResponse.statusCode).toBe(200);
		expect(detailResponse.payload).not.toContain(mediaRoot);
		expect(detailResponse.json()).toMatchObject({
			title: 'Preview Film',
			fileSizeBytes: mediaBytes.length,
			writers: ['Example Writer'],
			studios: ['Example Studio'],
			countries: ['Example Country'],
			certification: 'PG-13',
			rating: 7.2,
			resolution: { width: 1920, height: 1080 },
		});
		const cardPreview = await app.inject({ url: `/api/v1/media/${itemId}/card-preview` });
		expect(cardPreview.statusCode).toBe(200);
		expect(cardPreview.json()).toEqual({
			id: itemId,
			title: 'Preview Film',
			year: null,
			plot: 'A concise preview summary.',
			artworkUrl: null,
			rating: 7.2,
			primaryGenre: 'Adventure',
			actors: ['First Actor', 'Second Actor', 'Third Actor'],
		});
		expect((await app.inject({
			url: `/api/v1/media/${randomUUID()}/card-preview`,
		})).statusCode).toBe(404);

		const full = await app.inject({ url: `/api/v1/media/${itemId}/preview` });
		expect(full.statusCode).toBe(200);
		expect(full.rawPayload).toEqual(mediaBytes);
		expect(full.headers['content-type']).toMatch(/^video\/mp4/);
		expect(full.headers['accept-ranges']).toBe('bytes');
		expect(full.headers['content-length']).toBe(String(mediaBytes.length));

		const head = await app.inject({ method: 'HEAD', url: `/api/v1/media/${itemId}/preview` });
		expect(head.statusCode).toBe(200);
		expect(head.headers['content-length']).toBe(String(mediaBytes.length));
		expect(head.rawPayload).toHaveLength(0);

		const bounded = await app.inject({
			url: `/api/v1/media/${itemId}/preview`,
			headers: { range: 'bytes=2-5' },
		});
		expect(bounded.statusCode).toBe(206);
		expect(bounded.rawPayload.toString()).toBe('2345');
		expect(bounded.headers['content-range']).toBe(`bytes 2-5/${mediaBytes.length}`);
		expect(bounded.headers['content-length']).toBe('4');

		const suffix = await app.inject({
			url: `/api/v1/media/${itemId}/preview`,
			headers: { range: 'bytes=-3' },
		});
		expect(suffix.statusCode).toBe(206);
		expect(suffix.rawPayload.toString()).toBe('789');

		const openEnded = await app.inject({
			url: `/api/v1/media/${itemId}/preview`,
			headers: { range: 'bytes=7-' },
		});
		expect(openEnded.statusCode).toBe(206);
		expect(openEnded.rawPayload.toString()).toBe('789');

		const rejected = await app.inject({
			url: `/api/v1/media/${itemId}/preview`,
			headers: { range: 'bytes=20-30' },
		});
		expect(rejected.statusCode).toBe(416);
		expect(rejected.headers['content-range']).toBe(`bytes */${mediaBytes.length}`);

		await rm(mediaRoot, { recursive: true, force: true });
		expect((await app.inject({
			url: `/api/v1/media/${itemId}/card-preview`,
		})).statusCode).toBe(200);
		const unavailable = await app.inject({ url: `/api/v1/media/${itemId}/preview` });
		expect(unavailable.statusCode).toBe(503);
	});

	it('validates merged library updates and immediately reconciles index-affecting changes', async () => {
		const { app, services, root } = await fixture();
		const firstRoot = path.join(root, 'first-media');
		const secondRoot = path.join(root, 'second-media');
		await Promise.all([mkdir(firstRoot), mkdir(secondRoot)]);
		await writeFile(path.join(firstRoot, 'Old.mp4'), 'old-video');
		await writeFile(path.join(firstRoot, 'Old.nfo'), '<movie><title>Old Item</title></movie>');
		await writeFile(path.join(secondRoot, 'New.mp4'), 'new-video');
		await writeFile(path.join(secondRoot, 'New.nfo'), '<movie><title>New Item</title></movie>');
		const library = await services.repository.createLibrary(
			libraryCreateSchema.parse({
				name: 'Mutable Library',
				typeKey: 'movies',
				sourceType: 'on-disk',
				sourceConfig: { scanRoot: firstRoot, playbackRoot: '/old' },
				watcherEnabled: false,
			}),
		);
		await services.scanner.scan(library.id, 'initial');

		const unsupported = await app.inject({
			method: 'PATCH',
			url: `/api/v1/libraries/${library.id}`,
			payload: { sourceType: 'future-provider' },
		});
		expect(unsupported.statusCode).toBe(400);
		const missing = await app.inject({
			method: 'PATCH',
			url: `/api/v1/libraries/${library.id}`,
			payload: {
				sourceConfig: { scanRoot: path.join(root, 'missing'), playbackRoot: '/missing' },
			},
		});
		expect(missing.statusCode).toBe(400);
		expect((await services.repository.getLibrary(library.id))?.sourceConfig.scanRoot).toBe(
			firstRoot,
		);

		const changed = await app.inject({
			method: 'PATCH',
			url: `/api/v1/libraries/${library.id}`,
			payload: { sourceConfig: { scanRoot: secondRoot, playbackRoot: '/new' } },
		});
		expect(changed.statusCode).toBe(200);
		const candidate = await eventually(
			async () =>
				(await app.inject({ url: `/api/v1/libraries/${library.id}/reconciliation` })).json() as {
					status: string;
					revision: string | null;
					candidateSummary: { discoveredCount: number } | null;
				},
			(result) =>
				result.status === 'source-approval-required'
				&& result.candidateSummary?.discoveredCount === 1,
		);
		const accepted = await app.inject({
			method: 'POST',
			url: `/api/v1/libraries/${library.id}/reconciliation`,
			payload: { action: 'accept-source', revision: candidate.revision },
		});
		expect(accepted.statusCode).toBe(202);
		const indexed = await eventually(
			async () =>
				(await app.inject({ url: `/api/v1/libraries/${library.id}/media` })).json() as {
					items: Array<{ title: string; playbackPath: string }>;
				},
			(result) =>
				result.items.some(
					(item) => item.title === 'New Item' && item.playbackPath === '/new/New.mp4',
				),
		);
		expect(indexed.items.map((item) => item.title)).toEqual(['New Item']);
	});

	it('supports scheduling overview, assignments, draft previews, and the batch guide', async () => {
		const { app, services } = await fixture();
		const channelResponse = await app.inject({
			method: 'POST',
			url: '/api/v1/channels',
			payload: channelCreateSchema.parse({ number: '10', name: 'Schedule Test' }),
		});
		const channelId = channelResponse.json().id as string;
		const sourceItemId = randomUUID();
		const programResponse = await app.inject({
			method: 'POST',
			url: '/api/v1/programs',
			payload: {
				name: 'Missing film',
				config: {
					type: 'content',
					source: { type: 'item', itemId: sourceItemId },
					strategy: { type: 'sequential' },
				},
			},
		});
		expect(programResponse.statusCode).toBe(201);
		const programId = programResponse.json().id as string;
		const duplicateCollectionItemId = randomUUID();
		expect(
			(
				await app.inject({
					method: 'POST',
					url: '/api/v1/programs',
					payload: {
						name: 'Invalid duplicate collection',
						config: {
							type: 'content',
							source: {
								type: 'collection',
								libraryId: randomUUID(),
								itemIds: [duplicateCollectionItemId, duplicateCollectionItemId],
							},
							strategy: { type: 'sequential' },
						},
					},
				})
			).statusCode,
		).toBe(400);
		const slotId = randomUUID();
		const templateBody = {
			name: 'Daily',
			period: 'day',
			defaultFiller: null,
			slots: [
				{
					id: slotId,
					startSeconds: 0,
					programId,
					stateScope: 'persistent',
					startEligibility: { type: 'require-fit' },
					filler: { mode: 'inherit' },
				},
			],
			boundaries: [
				{
					id: randomUUID(),
					leftSlotId: slotId,
					rightSlotId: slotId,
					targetSeconds: SECONDS_PER_SCHEDULING_DAY,
					policy: 'hard',
					maxDriftSeconds: 0,
					fallback: 'reject-start',
				},
			],
		};
		const templateResponse = await app.inject({
			method: 'POST',
			url: '/api/v1/schedule-templates',
			payload: templateBody,
		});
		expect(templateResponse.statusCode).toBe(201);
		const templateId = templateResponse.json().id as string;
		expect(
			(
				await app.inject({
					method: 'PUT',
					url: `/api/v1/schedule-templates/${templateId}/assignments`,
					payload: { channelIds: [channelId] },
				})
			).statusCode,
		).toBe(200);

		const overlaySlotId = randomUUID();
		const overlayResponse = await app.inject({
			method: 'POST',
			url: '/api/v1/schedule-templates',
			payload: {
				...templateBody,
				name: 'Weekday overlay',
				slots: [
					{
						...templateBody.slots[0],
						id: overlaySlotId,
						programId: null,
						filler: { mode: 'disabled' },
					},
				],
				boundaries: [
					{
						...templateBody.boundaries[0],
						id: randomUUID(),
						leftSlotId: overlaySlotId,
						rightSlotId: overlaySlotId,
					},
				],
			},
		});
		expect(overlayResponse.statusCode).toBe(201);
		const overlayTemplateId = overlayResponse.json().id as string;
		const layerId = randomUUID();
		const layeredAssignment = await app.inject({
			method: 'PUT',
			url: `/api/v1/channels/${channelId}/schedule`,
			payload: {
				defaultTemplateId: templateId,
				layers: [
					{
						id: layerId,
						templateId: overlayTemplateId,
						predicate: {
							type: 'all',
							children: [
								{ type: 'months', values: [12], negated: false },
								{ type: 'weekdays', values: [1, 2, 3, 4, 5], negated: false },
							],
						},
						entryBoundary: {
							policy: 'hard',
							maxDriftSeconds: 0,
							fallback: 'truncate-left',
						},
						exitBoundary: {
							policy: 'hard',
							maxDriftSeconds: 0,
							fallback: 'truncate-left',
						},
					},
				],
				defaultFiller: null,
			},
		});
		expect(layeredAssignment.statusCode).toBe(200);
		expect(layeredAssignment.json()).toMatchObject({
			channelId,
			defaultTemplateId: templateId,
			layers: [{ id: layerId, templateId: overlayTemplateId }],
		});

		const overview = (await app.inject({ url: '/api/v1/scheduling/overview' })).json();
		expect(overview).toMatchObject({
			programs: [{ id: programId }],
			templates: expect.arrayContaining([
				expect.objectContaining({ id: templateId }),
				expect.objectContaining({ id: overlayTemplateId }),
			]),
			channelSchedules: [
				expect.objectContaining({
					channelId,
					defaultTemplateId: templateId,
					layers: [expect.objectContaining({ id: layerId, templateId: overlayTemplateId })],
				}),
			],
			programStatuses: [{ programId, health: 'missing' }],
		});
		const draft = (
			await app.inject({
				method: 'POST',
				url: '/api/v1/timeline-preview',
				payload: {
					channelId,
					template: { ...templateBody, id: templateId },
					startDate: '2026-08-20',
					days: 1,
				},
			})
		).json();
		expect(
			draft.issues.some((issue: { code: string }) => issue.code === 'source-reference-missing'),
		).toBe(true);
		const defaultDraft = await app.inject({
			method: 'POST',
			url: '/api/v1/timeline-preview',
			payload: {
				template: { ...templateBody, id: templateId },
				days: 1,
			},
		});
		expect(defaultDraft.statusCode).toBe(200);
		expect(defaultDraft.json()).toMatchObject({
			channelId: '00000000-0000-4000-8000-000000000001',
			days: 1,
		});
		const layeredDraft = await app.inject({
			method: 'POST',
			url: '/api/v1/channel-schedule-preview',
			payload: {
				channelId,
				schedule: layeredAssignment.json(),
				startDate: '2026-12-07',
				days: 1,
			},
		});
		expect(layeredDraft.statusCode).toBe(200);
		expect(layeredDraft.json()).toMatchObject({ channelId, days: 1 });
		const persistedPreview = await app.inject({
			url: `/api/v1/channels/${channelId}/timeline-preview?startDate=2026-08-20&days=1`,
		});
		expect(persistedPreview.statusCode).toBe(200);
		for (const preview of [draft, layeredDraft.json(), persistedPreview.json()]) {
			expect(preview.issues.length).toBeGreaterThan(0);
			for (const issue of preview.issues) {
				expect(issue.occurrenceCount).toBeGreaterThan(0);
				expect(issue).not.toHaveProperty('occurrenceCounts');
				expect(issue).not.toHaveProperty('unlocatedOccurrenceCount');
				expect(issue).not.toHaveProperty('unlocatedUntil');
			}
		}

		await services.timelineMaterializer.runNow();
		const materialization = await services.repository.getTimelineMaterialization(channelId);
		expect(materialization?.issues.length).toBeGreaterThan(0);
		expect(materialization?.issues[0]?.occurrenceCounts?.length).toBeGreaterThan(0);
		const guide = (await app.inject({ url: '/api/v1/schedule-guide?days=1' })).json();
		expect(guide.channels).toMatchObject([{ channelId, preview: { days: 1 } }]);
		for (const issue of guide.channels[0].preview.issues) {
			expect(issue).not.toHaveProperty('occurrenceCounts');
		}
	}, 15_000);

	it('keeps a program type, source type, and library fixed after creation', async () => {
		const { app, services } = await fixture();
		const libraryId = randomUUID();
		const initialConfig = {
			type: 'content' as const,
			source: {
				type: 'library-query' as const,
				libraryId,
				kinds: ['movie'],
				genres: [],
			},
			strategy: { type: 'sequential' as const },
		};
		const created = await app.inject({
			method: 'POST',
			url: '/api/v1/programs',
			payload: { name: 'Fixed structure', config: initialConfig },
		});
		expect(created.statusCode).toBe(201);
		const programId = created.json().id as string;

		const changedType = await app.inject({
			method: 'PATCH',
			url: `/api/v1/programs/${programId}`,
			payload: {
				config: {
					type: 'sequence',
					entries: [{ id: randomUUID(), programId, count: 1 }],
					repeat: true,
				},
			},
		});
		expect(changedType.statusCode).toBe(400);

		const changedSourceType = await app.inject({
			method: 'PATCH',
			url: `/api/v1/programs/${programId}`,
			payload: {
				config: {
					type: 'content',
					source: { type: 'collection', libraryId, itemIds: [randomUUID()] },
					strategy: { type: 'sequential' },
				},
			},
		});
		expect(changedSourceType.statusCode).toBe(400);

		const changedLibrary = await app.inject({
			method: 'PATCH',
			url: `/api/v1/programs/${programId}`,
			payload: {
				config: {
					...initialConfig,
					source: { ...initialConfig.source, libraryId: randomUUID() },
				},
			},
		});
		expect(changedLibrary.statusCode).toBe(400);
		expect((await services.repository.getProgram(programId))?.config).toEqual(initialConfig);

		const missingItemId = randomUUID();
		const missingItemProgram = await app.inject({
			method: 'POST',
			url: '/api/v1/programs',
			payload: {
				name: 'Missing exact item',
				config: {
					type: 'content',
					source: { type: 'item', itemId: missingItemId },
					strategy: { type: 'sequential' },
				},
			},
		});
		const changedMissingItem = await app.inject({
			method: 'PATCH',
			url: `/api/v1/programs/${missingItemProgram.json().id}`,
			payload: {
				config: {
					type: 'content',
					source: { type: 'item', itemId: randomUUID() },
					strategy: { type: 'sequential' },
				},
			},
		});
		expect(changedMissingItem.statusCode).toBe(400);

		const changedBehavior = await app.inject({
			method: 'PATCH',
			url: `/api/v1/programs/${programId}`,
			payload: {
				name: 'Editable behavior',
				config: {
					...initialConfig,
					strategy: { type: 'shuffle', seed: 'retained-source' },
				},
			},
		});
		expect(changedBehavior.statusCode).toBe(200);
		expect(changedBehavior.json()).toMatchObject({
			name: 'Editable behavior',
			config: { strategy: { type: 'shuffle', seed: 'retained-source' } },
		});
	});

	it('creates a channel and exposes it through the integrated M3U playlist', async () => {
		const { app } = await fixture();
		const created = await app.inject({
			method: 'POST',
			url: '/api/v1/channels',
			payload: channelCreateSchema.parse({ number: '1', name: 'Test Channel' }),
		});
		expect(created.statusCode).toBe(201);
		const playlist = await app.inject({ url: '/iptv/channels.m3u' });
		expect(playlist.statusCode).toBe(200);
		expect(playlist.body).toContain('Test Channel');
		expect(playlist.body).toContain('https://moirai.example.test/iptv/channel/1.m3u8');
	});

	it('previews Quick Setup samples and a local day without persisting resources', async () => {
		const { app, services, root } = await fixture();
		const mediaRoot = path.join(root, 'quick-review-media');
		await mkdir(mediaRoot);
		for (let index = 0; index < 14; index += 1) {
			await writeFile(path.join(mediaRoot, `Movie ${String(index).padStart(2, '0')}.mp4`), 'video');
		}
		const library = await services.repository.createLibrary(libraryCreateSchema.parse({
			name: 'Review Movies', typeKey: 'movies', sourceType: 'on-disk',
			sourceConfig: { scanRoot: mediaRoot, playbackRoot: null },
		}));
		await services.scanner.scan(library.id, 'manual');
		const payload = {
			scenario: 'movies', libraryId: library.id, programName: 'Review program',
			source: { type: 'library-query', name: 'Movie', itemLimit: 2, sort: { type: 'name', direction: 'desc' } },
			strategy: { type: 'sequential' }, channel: { number: '91', name: 'Review channel', group: null },
		};
		const response = await app.inject({ method: 'POST', url: '/api/v1/quick-channel-setups/preview', payload });
		expect(response.statusCode, response.body).toBe(200);
		const review = response.json();
		expect(review.library.items).toHaveLength(12);
		expect(review.library.indexedItemCount).toBe(14);
		expect(review.programming.items.map((item: { title: string }) => item.title)).toEqual(['Movie 13', 'Movie 12']);
		expect(review.schedule.days).toBe(1);
		expect(review.schedule.segments.length).toBeGreaterThan(0);
		const midnight = Temporal.PlainDate.from(review.schedule.startDate)
			.toZonedDateTime(review.schedule.timeZone);
		expect(review.schedule.segments[0].start).toBe(midnight.toInstant().toString());
		expect(Date.parse(review.schedule.segments.at(-1).finish))
			.toBeGreaterThan(midnight.add({ days: 1 }).epochMilliseconds);
		expect(await services.repository.listPrograms()).toEqual([]);
		expect(await services.repository.listScheduleTemplates()).toEqual([]);
		expect(await services.repository.listChannels()).toEqual([]);
		expect(await services.repository.listChannelSchedules()).toEqual([]);
		expect(await services.repository.getSelectionState(review.schedule.channelId)).toEqual([]);
		const itemIds = review.programming.items.map((item: { id: string }) => item.id).reverse();
		const explicit = await app.inject({ method: 'POST', url: '/api/v1/quick-channel-setups/preview',
			payload: { ...payload, source: { type: 'collection', itemIds } } });
		expect(explicit.statusCode).toBe(200);
		expect(explicit.json().programming.items.map((item: { id: string }) => item.id)).toEqual(itemIds);
		const empty = await app.inject({ method: 'POST', url: '/api/v1/quick-channel-setups/preview',
			payload: { ...payload, source: { type: 'library-query', name: 'No matching title' } } });
		expect(empty.statusCode).toBe(200);
		expect(empty.json().programming.items).toEqual([]);
		expect(empty.json().schedule.issues.length).toBeGreaterThan(0);
	}, 30_000);

	it('creates an atomic quick channel setup through the management API', async () => {
		const { app, services } = await fixture();
		const library = await services.repository.createLibrary(libraryCreateSchema.parse({
			name: 'Quick Movies',
			typeKey: 'movies',
			sourceType: 'on-disk',
			sourceConfig: { scanRoot: '/media/quick', playbackRoot: null },
		}));
		const preview = await app.inject({
			method: 'POST',
			url: '/api/v1/quick-channel-setups/query-preview',
			payload: {
				scenario: 'movies',
				libraryId: library.id,
				genres: ['drama'],
			},
		});
		const created = await app.inject({
			method: 'POST',
			url: '/api/v1/quick-channel-setups',
			payload: {
				scenario: 'movies',
				libraryId: library.id,
				programName: 'Quick Movie Programming',
				source: { type: 'library-query', genres: ['drama'], name: 'feature' },
				strategy: { type: 'shuffle', seed: '' },
				channel: { number: '71', name: 'Quick Movies', group: 'Movies' },
			},
		});

		expect(preview.statusCode).toBe(200);
		expect(preview.json()).toEqual({ indexedItemCount: 0, items: [], nextCursor: null });
		expect(created.statusCode).toBe(201);
		expect(created.json()).toMatchObject({
			program: {
				name: 'Quick Movie Programming',
				config: {
					source: {
						libraryId: library.id,
						kinds: ['movie'],
						genres: ['drama'],
						name: 'feature',
					},
				},
			},
			template: {
				name: 'Quick Movies Daily',
				boundaries: [{ policy: 'finish-left', maxDriftSeconds: null }],
			},
			channel: { number: '71', name: 'Quick Movies' },
			schedule: { layers: [], defaultFiller: null },
		});
		expect(created.json().schedule.channelId).toBe(created.json().channel.id);
		expect(created.json().schedule.defaultTemplateId).toBe(created.json().template.id);
	});

	it('paginates Quick Setup query matches in stable program order', async () => {
		const { app, services, root } = await fixture();
		const mediaRoot = path.join(root, 'quick-query-media');
		await mkdir(mediaRoot);
		for (const title of ['Zulu', 'Alpha', 'Middle']) {
			await writeFile(path.join(mediaRoot, `${title}.mp4`), 'video');
			await writeFile(
				path.join(mediaRoot, `${title}.nfo`),
				`<movie><title>${title}</title></movie>`,
			);
		}
		const library = await services.repository.createLibrary(libraryCreateSchema.parse({
			name: 'Paged Quick Movies',
			typeKey: 'movies',
			sourceType: 'on-disk',
			sourceConfig: { scanRoot: mediaRoot, playbackRoot: null },
		}));
		await services.scanner.scan(library.id, 'manual');

		const first = await app.inject({
			method: 'POST',
			url: '/api/v1/quick-channel-setups/query-preview',
			payload: {
				scenario: 'movies',
				libraryId: library.id,
				genres: [],
				limit: 2,
			},
		});
		const firstPage = first.json();
		const second = await app.inject({
			method: 'POST',
			url: '/api/v1/quick-channel-setups/query-preview',
			payload: {
				scenario: 'movies',
				libraryId: library.id,
				genres: [],
				cursor: firstPage.nextCursor,
				limit: 2,
			},
		});
		const filtered = await app.inject({
			method: 'POST',
			url: '/api/v1/quick-channel-setups/query-preview',
			payload: {
				scenario: 'movies',
				libraryId: library.id,
				genres: [],
				name: 'alpha',
			},
		});
		const limited = await app.inject({
			method: 'POST',
			url: '/api/v1/quick-channel-setups/query-preview',
			payload: {
				scenario: 'movies',
				libraryId: library.id,
				genres: [],
				sort: { type: 'name', direction: 'desc' },
				itemLimit: 2,
			},
		});

		expect(first.statusCode).toBe(200);
		expect(firstPage.indexedItemCount).toBe(3);
		expect(firstPage.items.map((item: { title: string }) => item.title))
			.toEqual(['Alpha', 'Middle']);
		expect(firstPage.nextCursor).toBe('2');
		expect(second.statusCode).toBe(200);
		expect(second.json().items.map((item: { title: string }) => item.title)).toEqual(['Zulu']);
		expect(second.json().nextCursor).toBeNull();
		expect(filtered.json()).toMatchObject({
			indexedItemCount: 1,
			items: [{ title: 'Alpha' }],
			nextCursor: null,
		});
		expect(limited.json()).toMatchObject({
			indexedItemCount: 2,
			items: [{ title: 'Zulu' }, { title: 'Middle' }],
			nextCursor: null,
		});
	});

	it('uses distinct generated TVG identifiers in the client playlist', async () => {
		const { app } = await fixture();
		const first = await app.inject({
			method: 'POST',
			url: '/api/v1/channels',
			payload: channelCreateSchema.parse({ number: '100.1', name: 'First' }),
		});
		expect(first.statusCode).toBe(201);
		const second = await app.inject({
			method: 'POST',
			url: '/api/v1/channels',
			payload: channelCreateSchema.parse({ number: '100.2', name: 'Second' }),
		});
		expect(second.statusCode).toBe(201);
		const playlist = (await app.inject({ url: '/iptv/channels.m3u' })).body;
		expect(playlist).toContain(`tvg-id="${effectiveChannelTvgId(first.json())}"`);
		expect(playlist).toContain(`tvg-id="${effectiveChannelTvgId(second.json())}"`);
	});

	it('persists and reports the integrated playback capacity', async () => {
		const { app } = await fixture();
		const saved = await app.inject({
			method: 'PUT',
			url: '/api/v1/playback/settings',
			payload: { maxActiveSessions: 6 },
		});
		expect(saved.statusCode).toBe(200);
		expect(saved.json()).toEqual({
			maxActiveSessions: 6,
			viewingPreferencesEnabled: true,
		});
		const status = await app.inject({ url: '/api/v1/playback/status' });
		expect(status.headers['cache-control']).toBe('private, no-store');
		expect(status.json()).toMatchObject({
			maxActiveSessions: 6,
			activeSessionCount: 0,
			m3uUrl: 'https://moirai.example.test/iptv/channels.m3u',
			epgUrl: 'https://moirai.example.test/epg.xml',
		});
	});

	it('lists and explicitly clears local viewing preferences', async () => {
		const { app } = await fixture();
		const listed = await app.inject({ url: '/api/v1/viewing-preferences' });
		expect(listed.statusCode).toBe(200);
		expect(listed.json()).toEqual([]);
		const rejected = await app.inject({
			method: 'POST',
			url: '/api/v1/viewing-preferences/clear',
			payload: { confirmation: 'clear' },
		});
		expect(rejected.statusCode).toBe(400);
		const cleared = await app.inject({
			method: 'POST',
			url: '/api/v1/viewing-preferences/clear',
			payload: { confirmation: 'CLEAR VIEWING HISTORY' },
		});
		expect(cleared.statusCode).toBe(204);
	});

	it('predicts Automatic using server-visible playback hardware', async () => {
		const { app } = await fixture();
		const response = await app.inject({
			method: 'POST',
			url: '/api/v1/playback/hardware-acceleration/predict',
			payload: {
				format: 'h264',
				bitDepth: 8,
				width: 1920,
				height: 1080,
				vaapiDevice: null,
				vaapiDriver: null,
				ffmpegPath: '/definitely/missing/moirai-ffmpeg',
			},
		});
		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({ outcome: 'indeterminate', accel: null });
	});

	it('stores, proxies, lists, and removes a resolution-bounded channel logo', async () => {
		const { app } = await fixture();
		const forged = await app.inject({
			method: 'POST',
			url: '/api/v1/channels',
			payload: channelCreateSchema.parse({
				number: 'forged',
				name: 'Forged Logo',
				logo: 'moirai://channel-logo/2be7a2b9-81b5-4a72-a3d8-ad4e6394dd25',
			}),
		});
		expect(forged.statusCode).toBe(400);

		const created = (
			await app.inject({
				method: 'POST',
				url: '/api/v1/channels',
				payload: channelCreateSchema.parse({ number: '2', name: 'Logo Channel' }),
			})
		).json();

		const uploaded = await app.inject({
			method: 'PUT',
			url: `/api/v1/channels/${created.id}/logo`,
			headers: { 'content-type': 'image/png' },
			payload: transparentPng,
		});
		expect(uploaded.statusCode).toBe(200);
		expect(uploaded.json().logo).toMatch(/^moirai:\/\/channel-logo\//);
		const epg = await app.inject({ url: '/epg.xml' });
		expect(epg.payload).toContain(
			`/api/v1/channels/${created.id}/logo?v=${encodeURIComponent(uploaded.json().updatedAt)}`,
		);

		const proxied = await app.inject({ url: `/api/v1/channels/${created.id}/logo` });
		expect(proxied.statusCode).toBe(200);
		expect(proxied.headers['content-type']).toMatch(/^image\/png/);
		expect(proxied.rawPayload).toEqual(transparentPng);

		const playlist = (await app.inject({ url: '/iptv/channels.m3u' })).body;
		expect(playlist).toContain(
			`https://moirai.example.test/api/v1/channels/${created.id}/logo?v=`,
		);

		const oversized = Buffer.from(transparentPng);
		oversized.writeUInt32BE(1081, 20);
		const rejected = await app.inject({
			method: 'PUT',
			url: `/api/v1/channels/${created.id}/logo`,
			headers: { 'content-type': 'image/png' },
			payload: oversized,
		});
		expect(rejected.statusCode).toBe(400);

		const removed = await app.inject({
			method: 'DELETE',
			url: `/api/v1/channels/${created.id}/logo`,
		});
		expect(removed.statusCode).toBe(200);
		expect(removed.json().logo).toBeNull();
		expect((await app.inject({ url: `/api/v1/channels/${created.id}/logo` })).statusCode).toBe(404);
	}, 15_000);

	it('uploads, inherits, previews, and removes managed playback fallback fillers', async () => {
		const { app } = await fixture();
		const wrongField = multipartVideo(
			'wrong-field.mp4',
			Buffer.from('rejected-fallback-video'),
			'video',
		);
		const rejectedField = await app.inject({
			method: 'PUT',
			url: '/api/v1/playback/fallback-filler',
			headers: wrongField.headers,
			payload: wrongField.payload,
		});
		expect(rejectedField.statusCode).toBe(400);

		const initial = await app.inject({ url: '/api/v1/playback/fallback-filler' });
		expect(initial.statusCode).toBe(200);
		expect(initial.json()).toMatchObject({
			override: null,
			overrideConfigured: false,
			effective: { source: 'bundled', hasAudio: true },
			inherited: { source: 'bundled', previewUrl: '/api/v1/playback/fallback-filler/bundled-preview' },
		});
		const bundledPreview = await app.inject({
			url: '/api/v1/playback/fallback-filler/bundled-preview',
			headers: { range: 'bytes=0-5' },
		});
		expect(bundledPreview.statusCode).toBe(206);
		expect(bundledPreview.rawPayload).toHaveLength(6);

		const globalBytes = Buffer.from('global-fallback-video');
		const globalUpload = multipartVideo('global.mp4', globalBytes);
		const uploadedGlobal = await app.inject({
			method: 'PUT',
			url: '/api/v1/playback/fallback-filler',
			headers: globalUpload.headers,
			payload: globalUpload.payload,
		});
		expect(uploadedGlobal.statusCode).toBe(200);
		expect(uploadedGlobal.json()).toMatchObject({
			override: { source: 'global', filename: 'global.mp4' },
			overrideConfigured: true,
			effective: { source: 'global' },
			inherited: { source: 'bundled' },
		});
		const globalPreview = await app.inject({
			url: '/api/v1/playback/fallback-filler/preview',
			headers: { range: 'bytes=0-5' },
		});
		expect(globalPreview.statusCode).toBe(206);
		expect(globalPreview.rawPayload).toEqual(globalBytes.subarray(0, 6));

		const created = await app.inject({
			method: 'POST',
			url: '/api/v1/channels',
			payload: { number: 'fallback-test', name: 'Fallback Test' },
		});
		const channel = created.json();
		const inherited = await app.inject({
			url: `/api/v1/channels/${channel.id}/fallback-filler`,
		});
		expect(inherited.json()).toMatchObject({
			override: null,
			overrideConfigured: false,
			effective: { source: 'global' },
			inherited: { source: 'global' },
		});

		const socket = await app.injectWS('/api/v1/events');
		const uploadedChannelEvent = nextLiveEvent(
			socket,
			(event) => event.type === 'playback.changed'
				&& event.data.channelId === channel.id
				&& event.data.reason === 'fallback-applied',
		);
		const channelUpload = multipartVideo('channel.mp4', Buffer.from('channel-fallback-video'));
		const uploadedChannel = await app.inject({
			method: 'PUT',
			url: `/api/v1/channels/${channel.id}/fallback-filler`,
			headers: channelUpload.headers,
			payload: channelUpload.payload,
		});
		expect(uploadedChannel.statusCode).toBe(200);
		expect(uploadedChannel.json()).toMatchObject({
			override: { source: 'channel', filename: 'channel.mp4' },
			overrideConfigured: true,
			effective: { source: 'channel' },
			inherited: { source: 'global' },
		});
		await expect(uploadedChannelEvent).resolves.toMatchObject({
			type: 'playback.changed',
			data: { channelId: channel.id, reason: 'fallback-applied' },
		});

		const removedChannelEvent = nextLiveEvent(
			socket,
			(event) => event.type === 'playback.changed'
				&& event.data.channelId === channel.id
				&& event.data.reason === 'fallback-applied',
		);
		const removedChannel = await app.inject({
			method: 'DELETE',
			url: `/api/v1/channels/${channel.id}/fallback-filler`,
		});
		expect(removedChannel.json()).toMatchObject({
			override: null,
			overrideConfigured: false,
			effective: { source: 'global' },
		});
		await expect(removedChannelEvent).resolves.toMatchObject({
			type: 'playback.changed',
			data: { channelId: channel.id, reason: 'fallback-applied' },
		});
		socket.close();
		const removedGlobal = await app.inject({
			method: 'DELETE',
			url: '/api/v1/playback/fallback-filler',
		});
		expect(removedGlobal.json()).toMatchObject({
			override: null,
			overrideConfigured: false,
			effective: { source: 'bundled' },
		});
	}, 30_000);

	it('completes channel deletion while preserving fallback after playback cleanup fails', async () => {
		const { app, services } = await fixture();
		const created = await app.inject({
			method: 'POST',
			url: '/api/v1/channels',
			payload: { number: 'cleanup-failure', name: 'Cleanup Failure' },
		});
		const channel = created.json() as { id: string };
		await app.ready();
		const socket = await app.injectWS('/api/v1/events');
		const deletedEvent = nextLiveEvent(
			socket,
			(event) => event.type === 'channel.changed'
				&& event.data.channelId === channel.id
				&& event.data.change === 'deleted',
		);
		vi.spyOn(services.playback, 'handleChannelChange').mockImplementation(async () => {
			throw new Error('simulated playback cleanup failure');
		});
		const removeFallback = vi.spyOn(services.fallbackFillers, 'removeChannel');

		const removed = await app.inject({
			method: 'DELETE',
			url: `/api/v1/channels/${channel.id}`,
		});

		expect(removed.statusCode).toBe(204);
		expect(await services.repository.getChannel(channel.id)).toBeNull();
		expect(removeFallback).not.toHaveBeenCalled();
		await expect(deletedEvent).resolves.toMatchObject({
			type: 'channel.changed',
			data: { channelId: channel.id, change: 'deleted' },
		});
		socket.close();
	});

	it('commits saved schedules while repeated draft previews leave committed state unchanged', async () => {
		const { app, services, root } = await fixture();
		const library = await services.repository.createLibrary(
			libraryCreateSchema.parse({
				name: 'Schedule Movies',
				typeKey: 'movies',
				sourceType: 'on-disk',
				sourceConfig: { scanRoot: root, playbackRoot: '/media' },
				watcherEnabled: false,
			}),
		);
		const scheduledItems = Array.from(
			{ length: PROGRAM_ITEM_ADDITION_CONFIRMATION_THRESHOLD + 2 },
			(_, index) => {
				const number = index + 1;
				const title = number === 1 ? 'Scheduled Film' : `Scheduled Film ${number}`;
				return {
					id: randomUUID(),
					aliasIds: [],
					groupId: null,
					stableKey: `scheduled-film-${number}`,
					kind: 'movie' as const,
					title,
					sortTitle: title,
					relativePath: `${title}.mkv`,
					playbackPath: `/media/${title}.mkv`,
					nfoRelativePath: `${title}.nfo`,
					plot: null,
					year: 2026,
					durationMilliseconds: 3_600_000,
					probeFingerprint: `scheduled-film-${number}-probe`,
					probeStatus: 'complete' as const,
					probeUpdatedAt: '2026-08-24T00:00:00.000Z',
					probeErrorCode: null,
					technicalMetadata: {
						fileSizeBytes: 1,
						container: 'matroska',
						streams: [{ type: 'video' as const, codec: 'h264', width: 1920, height: 1080 }],
						resolution: { width: 1920, height: 1080 },
					},
					seasonNumber: null,
					episodeNumber: null,
					episodeEndNumber: null,
					edition: null,
					externalIds: [],
					trackNumber: null,
					discNumber: null,
					artists: [],
					multipartStatus: 'none' as const,
					parts: [],
					subtitleTracks: [],
					metadataStatus: 'complete' as const,
					metadata: {},
					artworkRelativePath: null,
					fingerprint: `scheduled-film-${number}-v1`,
					fileModifiedAt: '2026-01-01T00:00:00.000Z',
					titleBucket: 'S',
					genres: [],
					people: [],
				};
			},
		);
		const itemId = scheduledItems[0]!.id;
		await services.repository.reconcileScan(
			await services.repository.beginScan(library.id, 'initial'),
			[],
			scheduledItems,
			[],
			true,
		);
		const selection = await app.inject({
			method: 'POST',
			url: `/api/v1/libraries/${library.id}/media-selection`,
			payload: { itemIds: [randomUUID(), itemId] },
		});
		expect(selection.statusCode).toBe(200);
		expect(selection.json()).toMatchObject([{ id: itemId, title: 'Scheduled Film' }]);
		const channel = (
			await app.inject({
				method: 'POST',
				url: '/api/v1/channels',
				payload: channelCreateSchema.parse({ number: 'schedule', name: 'Schedule Channel' }),
			})
		).json();
		const confirmationProgram = await services.repository.createProgram({
			name: 'Confirm scheduled films',
			config: {
				type: 'content',
				source: {
					type: 'collection',
					libraryId: library.id,
					itemIds: [itemId],
					sort: { type: 'date-added', direction: 'asc' },
				},
				strategy: { type: 'sequential' },
			},
		});
		const confirmationPayload = {
			destination: { type: 'existing' as const, programId: confirmationProgram.id },
			selection: { type: 'query' as const, query: { name: 'Scheduled' } },
		};
		const confirmation = await app.inject({
			method: 'POST',
			url: `/api/v1/libraries/${library.id}/program-items`,
			payload: confirmationPayload,
		});
		expect(confirmation.statusCode).toBe(409);
		const confirmationBody = confirmation.json();
		expect(confirmationBody).toMatchObject({
			code: 'program_item_confirmation_required',
			details: {
				addedItemCount: PROGRAM_ITEM_ADDITION_CONFIRMATION_THRESHOLD + 1,
				alreadySelectedCount: 1,
			},
		});
		expect(confirmationBody.details.confirmationToken).toMatch(/^[a-f0-9]{64}$/);
		expect(confirmationBody.details.items).toHaveLength(
			PROGRAM_ITEM_ADDITION_CONFIRMATION_THRESHOLD + 1,
		);
		expect(confirmationBody.details.items[0]).toMatchObject({
			title: 'Scheduled Film 2',
			year: 2026,
		});
		expect((await services.repository.getProgram(confirmationProgram.id))?.config)
			.toEqual(confirmationProgram.config);
		const confirmedAddition = await app.inject({
			method: 'POST',
			url: `/api/v1/libraries/${library.id}/program-items`,
			payload: {
				...confirmationPayload,
				confirmedAdditionToken: confirmationBody.details.confirmationToken,
			},
		});
		expect(confirmedAddition.statusCode).toBe(200);
		expect(confirmedAddition.json()).toMatchObject({
			created: false,
			matchedItemCount: PROGRAM_ITEM_ADDITION_CONFIRMATION_THRESHOLD + 2,
			addedItemCount: PROGRAM_ITEM_ADDITION_CONFIRMATION_THRESHOLD + 1,
			alreadySelectedCount: 1,
		});
		const supersededConfirmation = await app.inject({
			method: 'POST',
			url: `/api/v1/libraries/${library.id}/program-items`,
			payload: {
				...confirmationPayload,
				confirmedAdditionToken: confirmationBody.details.confirmationToken,
			},
		});
		expect(supersededConfirmation.statusCode).toBe(409);
		expect(supersededConfirmation.json()).toMatchObject({
			code: 'program_item_confirmation_required',
			details: {
				addedItemCount: 0,
				alreadySelectedCount: PROGRAM_ITEM_ADDITION_CONFIRMATION_THRESHOLD + 2,
			},
		});
		const programAddition = await app.inject({
			method: 'POST',
			url: `/api/v1/libraries/${library.id}/program-items`,
			payload: {
				destination: {
					type: 'new',
					name: 'All Day Film',
					strategy: { type: 'sequential' },
				},
				selection: {
					type: 'query',
					query: { name: 'Scheduled' },
				},
			},
		});
		expect(programAddition.statusCode).toBe(201);
		expect(programAddition.json()).toMatchObject({
			created: true,
			matchedItemCount: PROGRAM_ITEM_ADDITION_CONFIRMATION_THRESHOLD + 2,
			addedItemCount: PROGRAM_ITEM_ADDITION_CONFIRMATION_THRESHOLD + 2,
			alreadySelectedCount: 0,
		});
		const program = programAddition.json().program;
		const duplicateAddition = await app.inject({
			method: 'POST',
			url: `/api/v1/libraries/${library.id}/program-items`,
			payload: {
				destination: { type: 'existing', programId: program.id },
				selection: { type: 'items', itemIds: [itemId] },
			},
		});
		expect(duplicateAddition.statusCode).toBe(200);
		expect(duplicateAddition.json()).toMatchObject({
			created: false,
			matchedItemCount: 1,
			addedItemCount: 0,
			alreadySelectedCount: 1,
		});
		const slotId = randomUUID();
		const template = (
			await app.inject({
				method: 'POST',
				url: '/api/v1/schedule-templates',
				payload: {
					name: 'Every Day',
					slots: [
						{
							id: slotId,
							startSeconds: 0,
							programId: program.id,
							stateScope: 'persistent',
							startEligibility: { type: 'require-fit' },
							filler: { mode: 'inherit' },
						},
					],
					boundaries: [
						{
							id: randomUUID(),
							leftSlotId: slotId,
							rightSlotId: slotId,
							targetSeconds: SECONDS_PER_SCHEDULING_DAY,
							policy: 'hard',
							maxDriftSeconds: 0,
							fallback: 'reject-start',
						},
					],
				},
			})
		).json();
		const assigned = await app.inject({
			method: 'PUT',
			url: `/api/v1/channels/${channel.id}/schedule`,
			payload: { defaultTemplateId: template.id, defaultFiller: null },
		});
		expect(assigned.statusCode).toBe(200);

		await services.timelineMaterializer.runNow();
		const committedState = await services.repository.getSelectionState(channel.id);
		expect(committedState.length).toBeGreaterThan(0);
		const committedGuide = await app.inject({ url: '/api/v1/schedule-guide?days=1' });
		const repeatedGuide = await app.inject({ url: '/api/v1/schedule-guide?days=1' });
		expect(committedGuide.statusCode).toBe(200);
		expect(committedGuide.json().channels[0].preview.segments).toEqual(
			repeatedGuide.json().channels[0].preview.segments,
		);
		expect((await app.inject({ url: '/epg.xml' })).payload).toContain('Scheduled Film');
		const previewUrl = `/api/v1/channels/${channel.id}/timeline-preview?startDate=2026-01-05&days=1`;
		const first = await app.inject({ url: previewUrl });
		const second = await app.inject({ url: previewUrl });
		expect(first.statusCode).toBe(200);
		expect(first.json().segments).toHaveLength(24);
		expect(first.json().segments).toEqual(second.json().segments);
		expect(first.json().segments[0]).toMatchObject({
			role: 'primary',
			mediaItemId: itemId,
			playbackPath: '/media/Scheduled Film.mkv',
		});
		expect(await services.repository.getSelectionState(channel.id)).toEqual(committedState);
		const changedProgram = await app.inject({
			method: 'PATCH',
			url: `/api/v1/programs/${program.id}`,
			payload: { config: { ...program.config, strategy: { type: 'random', seed: 'changed' } } },
		});
		expect(changedProgram.statusCode).toBe(200);
		const pending = await eventually(
			async () => (await app.inject({ url: '/api/v1/scheduling/materializations' })).json(),
			(statuses: Array<{ channelId: string; health: string }>) =>
				statuses.some((status) => status.channelId === channel.id && status.health === 'pending'),
		);
		expect(pending).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ channelId: channel.id, health: 'pending' }),
			]),
		);
		const applied = await app.inject({
			method: 'POST',
			url: `/api/v1/channels/${channel.id}/materialization/apply-now`,
		});
		expect(applied.statusCode).toBe(202);
		expect(applied.json()).toMatchObject({ channelId: channel.id, health: 'ready' });
		await app.inject({ method: 'DELETE', url: `/api/v1/channels/${channel.id}` });
		expect(await services.repository.getSelectionState(channel.id)).toEqual([]);
	}, 15_000);
});
