import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	loadConfig,
	bundledNextRoot,
	resolveNextDevelopmentRoots,
	resolveManagementUrl,
	resolvePublicUrl,
	resolveTrustedProxies,
	publicUrlStatus,
	resolveTimeZone,
} from '@server/config.js';

afterEach(() => {
	vi.unstubAllEnvs();
});

describe('time-zone configuration', () => {
	it('accepts an explicit IANA time zone', () => {
		expect(loadConfig({ timeZone: 'America/Los_Angeles' }).timeZone).toBe('America/Los_Angeles');
	});

	it('defaults to the runtime time zone', () => {
		expect(resolveTimeZone()).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
	});

	it('rejects invalid values at startup', () => {
		expect(() => resolveTimeZone('Mars/Olympus_Mons')).toThrow(/IANA time zone/);
	});
});

describe('public URL configuration', () => {
	it('defaults to the configured local port', () => {
		expect(loadConfig({ port: 4312 }).publicUrl).toBe('http://127.0.0.1:4312');
	});

	it('normalizes an explicit HTTP origin', () => {
		expect(resolvePublicUrl('https://moirai.example.test/', 3000)).toBe(
			'https://moirai.example.test',
		);
	});

	it('allows a management UI on another port of the public origin', () => {
		expect(resolveManagementUrl(
			'https://moirai.example.test:5173',
			'https://moirai.example.test:3000',
		)).toBe('https://moirai.example.test:5173');
		expect(resolveManagementUrl(undefined, 'https://moirai.example.test')).toBe(
			'https://moirai.example.test',
		);

		vi.stubEnv('MOIRAI_PUBLIC_URL', 'https://moirai.example.test:3000');
		vi.stubEnv('MOIRAI_MANAGEMENT_URL', 'https://moirai.example.test:5173');
		expect(loadConfig().managementUrl).toBe('https://moirai.example.test:5173');
	});

	it('rejects a management origin that cannot receive the public origin cookie', () => {
		expect(() => resolveManagementUrl(
			'https://attacker.example.test',
			'https://moirai.example.test',
		)).toThrow(/same scheme and hostname/);
		expect(() => resolveManagementUrl(
			'http://moirai.example.test',
			'https://moirai.example.test',
		)).toThrow(/same scheme and hostname/);
	});

	it('rejects non-HTTP URLs', () => {
		expect(() => resolvePublicUrl('file:///tmp/moirai', 3000)).toThrow(/HTTP/);
	});

	it('rejects values that are not bare origins', () => {
		expect(() => resolvePublicUrl('https://moirai.example.test/moirai', 3000)).toThrow(/path/);
		expect(() => resolvePublicUrl('https://moirai.example.test/?token=secret', 3000)).toThrow(
			/query/,
		);
		expect(() => resolvePublicUrl('https://moirai.example.test/#guide', 3000)).toThrow(
			/fragment/,
		);
	});

	it('identifies URLs that remote IPTV clients cannot reach', () => {
		expect(publicUrlStatus('http://127.0.0.1:3000')).toBe('unreachable-default');
		expect(publicUrlStatus('http://localhost:3000')).toBe('unreachable-default');
		expect(publicUrlStatus('http://127.attacker.example:3000')).toBe('configured');
		expect(publicUrlStatus('https://moirai.example.test')).toBe('configured');
	});
});

describe('trusted proxy configuration', () => {
	it('accepts explicit IPs, CIDRs, and named local-network groups', () => {
		expect(resolveTrustedProxies('127.0.0.1, 10.0.0.0/8, uniquelocal')).toEqual([
			'127.0.0.1',
			'10.0.0.0/8',
			'uniquelocal',
		]);
	});

	it('rejects hostnames and invalid network prefixes', () => {
		expect(() => resolveTrustedProxies('proxy.example.test')).toThrow(/IP addresses/);
		expect(() => resolveTrustedProxies('10.0.0.0/64')).toThrow(/IP addresses/);
	});
});

describe('media probe configuration', () => {
	it('uses bounded defaults and accepts an explicit executable', () => {
		expect(loadConfig({ ffprobePath: '/opt/media/ffprobe' })).toMatchObject({
			ffprobePath: '/opt/media/ffprobe',
			mediaProbeConcurrency: 2,
			mediaProbeTimeoutMs: 15_000,
		});
	});
});

describe('byte-limit configuration', () => {
	it('falls back when a megabyte value would overflow finite integer bytes', () => {
		vi.stubEnv('MOIRAI_LOG_MAX_MB', '1e308');
		expect(loadConfig().logMaxBytes).toBe(200 * 1024 * 1024);
	});
});

describe('Logto authentication configuration', () => {
	it('requires an all-or-nothing traditional-web application configuration', () => {
		vi.stubEnv('MOIRAI_LOGTO_ENDPOINT', 'https://tenant.logto.app');
		expect(() => loadConfig()).toThrow(/configured together/);

		vi.stubEnv('MOIRAI_LOGTO_APP_ID', 'application-id');
		vi.stubEnv('MOIRAI_LOGTO_APP_SECRET', 'application-secret');
		expect(loadConfig().logto).toEqual({
			endpoint: 'https://tenant.logto.app',
			appId: 'application-id',
			appSecret: 'application-secret',
		});
	});

	it('rejects insecure remote provider endpoints while allowing loopback development', () => {
		vi.stubEnv('MOIRAI_LOGTO_APP_ID', 'application-id');
		vi.stubEnv('MOIRAI_LOGTO_APP_SECRET', 'application-secret');
		vi.stubEnv('MOIRAI_LOGTO_ENDPOINT', 'http://tenant.example.test');
		expect(() => loadConfig()).toThrow(/HTTPS origin/);

		vi.stubEnv('MOIRAI_LOGTO_ENDPOINT', 'http://127.0.0.1:3001');
		expect(loadConfig().logto?.endpoint).toBe('http://127.0.0.1:3001');

		vi.stubEnv('MOIRAI_LOGTO_ENDPOINT', 'http://[::1]:3001');
		expect(loadConfig().logto?.endpoint).toBe('http://[::1]:3001');

		vi.stubEnv('MOIRAI_LOGTO_ENDPOINT', 'http://127.attacker.example');
		expect(() => loadConfig()).toThrow(/HTTPS origin/);
	});
});

describe('integrated playback configuration', () => {
	it('uses private data directories and accepts an explicit engine', () => {
		const dataDir = path.resolve('test-results/moirai-playback-config');
		expect(loadConfig({ dataDir, playbackEnginePath: '/opt/moirai/ersatztv-channel' })).toMatchObject({
			playbackEnginePath: '/opt/moirai/ersatztv-channel',
			playbackStreamDir: path.join(dataDir, 'streams'),
			playbackPlayoutDir: path.join(dataDir, 'playout'),
			playbackSyncIntervalSeconds: 60,
			playbackReadyTimeoutMs: 30_000,
			playbackStopGraceMs: 5_000,
		});
	});

	it('checks an alternate Next checkout before the pinned development submodule', () => {
		const alternateRoot = path.resolve('test-results/alternate-next');
		expect(resolveNextDevelopmentRoots(alternateRoot)).toEqual([
			alternateRoot,
			bundledNextRoot,
		]);
	});
});
