import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	loadConfig,
	bundledNextRoot,
	resolveNextDevelopmentRoots,
	resolvePublicUrl,
	publicUrlStatus,
	resolveTimeZone,
} from '@server/config.js';

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
		expect(publicUrlStatus('https://moirai.example.test')).toBe('configured');
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
