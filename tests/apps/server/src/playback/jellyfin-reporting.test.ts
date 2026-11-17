import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import { remotePlaybackReference, type TimelineSegment } from '@moirai/shared';
import { MediaServerPlaybackReporter, PLAYBACK_REPORT_INTERVAL_MS, type ReportingChannel } from '@server/playback/media-server-reporting.js';
import { JELLYFIN_REPORT_TIMEOUT_MS } from '@server/media-servers/jellyfin-playback-client.js';
import type { MediaFetchInit } from '@server/media-servers/http.js';
import type { Repository } from '@server/repository/index.js';
import type { MediaServerConnectionRecord } from '@server/repository/media-servers.js';

const NOW = Date.parse('2026-11-16T22:00:00Z');
const SERVER = '11111111-1111-4111-8111-111111111111';

function segment(overrides: Partial<TimelineSegment> = {}): TimelineSegment {
	return {
		id: 'airing-1', channelId: 'channel-1', role: 'primary', scheduleLayerId: null,
		templateId: 'template', slotId: 'slot', programId: 'program', mediaItemId: 'media',
		title: 'Movie', playbackPath: remotePlaybackReference(SERVER, 'movie:version'),
		start: new Date(NOW - 60_000).toISOString(), finish: new Date(NOW + 120_000).toISOString(),
		sourceStartSeconds: 300, sourceFinishSeconds: 480, truncated: true, ...overrides,
	};
}

function fixture() {
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
	const connection: MediaServerConnectionRecord = {
		id: SERVER, provider: 'jellyfin', name: 'Jellyfin', baseUrl: 'https://jellyfin.example/root',
		serverKey: 'server', serverName: 'Jellyfin', clientIdentifier: 'saved-device',
		accessToken: 'synthetic-secret', allowInsecureTls: false, playbackReportingEnabled: true,
		pathReplacements: [],
	};
	let channels: ReportingChannel[] = [{ id: 'channel-1', number: '700.1', name: 'Jellyfin Test' }];
	let segments = [segment()];
	let connections = [connection];
	const requests: Array<{ url: string; init: MediaFetchInit; body: Record<string, any> }> = [];
	const warn = vi.fn();
	const fetch = vi.fn(async (url: string, init?: MediaFetchInit) => {
		requests.push({ url, init: init!, body: JSON.parse(init!.body!) });
		return { ok: true, status: 204, headers: { get: () => null }, body: null, text: async () => '', arrayBuffer: async () => new ArrayBuffer(0) };
	});
	const listConnections = vi.fn(async () => connections);
	const listSegments = vi.fn(async () => segments.map(segment => ({ segment, mediaSnapshot: null, stateDelta: [] })));
	const repository = {
		mediaServers: { playbackReportingConnections: listConnections }, listCurrentPlaybackSegments: listSegments,
	} as unknown as Repository;
	const reporter = new MediaServerPlaybackReporter(repository, () => channels, { warn } as unknown as FastifyBaseLogger, () => fetch);
	return {
		reporter, requests, fetch, warn, connection, listConnections, listSegments,
		channels: (value: ReportingChannel[]) => {
			channels = value; 
		},
		segments: (value: TimelineSegment[]) => {
			segments = value; 
		},
		connections: (value: MediaServerConnectionRecord[]) => {
			connections = value; 
		},
	};
}

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe('Jellyfin channel reporting', () => {
	it('reports a halfway tune and live progress once per channel with safe authentication', async () => {
		const f = fixture();
		await f.reporter.refresh();
		expect(f.requests).toHaveLength(1);
		expect(f.requests[0]!.url).toBe('https://jellyfin.example/root/Sessions/Playing');
		expect(f.requests[0]!.body).toMatchObject({
			ItemId: 'movie', MediaSourceId: 'version', PositionTicks: 360 * 10_000_000,
			CanSeek: false, IsPaused: false, PlayMethod: 'DirectPlay',
		});
		expect(f.requests[0]!.init.headers!.Authorization).toContain('Token="synthetic-secret"');
		expect(f.requests[0]!.url).not.toContain('synthetic-secret');
		expect(decodeURIComponent(f.requests[0]!.init.headers!.Authorization!)).toContain('700.1 Jellyfin Test');
		vi.setSystemTime(NOW + PLAYBACK_REPORT_INTERVAL_MS);
		await f.reporter.refresh();
		expect(f.requests[1]!.url).toMatch(/\/Progress$/);
		expect(f.requests[1]!.body.PositionTicks).toBe(375 * 10_000_000);
		expect(f.requests[1]!.body.PlaySessionId).toBe(f.requests[0]!.body.PlaySessionId);
		await f.reporter.close();
		expect(f.requests[2]!.url).toMatch(/\/Stopped$/);
	});

	it('stops and starts at the broadcast boundary without waiting for the progress interval', async () => {
		const f = fixture();
		f.segments([segment({ finish: new Date(NOW + 2_000).toISOString(), sourceFinishSeconds: 362 })]);
		f.reporter.start();
		await vi.advanceTimersByTimeAsync(0);
		f.segments([segment({
			id: 'airing-2', playbackPath: remotePlaybackReference(SERVER, 'next:next-source'),
			start: new Date(NOW + 2_000).toISOString(), sourceStartSeconds: 0,
		})]);
		await vi.advanceTimersByTimeAsync(2_000);
		expect(f.requests.map(request => new URL(request.url).pathname)).toEqual([
			'/root/Sessions/Playing', '/root/Sessions/Playing/Stopped', '/root/Sessions/Playing',
		]);
		expect(f.requests[1]!.body.PositionTicks).toBe(362 * 10_000_000);
		expect(f.requests[2]!.body).toMatchObject({ ItemId: 'next', MediaSourceId: 'next-source', PositionTicks: 0 });
		await f.reporter.close();
	});

	it('starts the next Jellyfin item at the end of a short local interlude', async () => {
		const f = fixture();
		f.segments([segment({ playbackPath: '/media/interlude.mp4', finish: new Date(NOW + 2_000).toISOString() })]);
		f.reporter.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(f.requests).toEqual([]);
		f.segments([segment({ start: new Date(NOW + 2_000).toISOString(), sourceStartSeconds: 0 })]);
		await vi.advanceTimersByTimeAsync(2_000);
		expect(f.requests).toHaveLength(1);
		expect(f.requests[0]!.body.PositionTicks).toBe(0);
		await f.reporter.close();
	});

	it('uses separate stable devices for concurrent channels and omits unsafe channel-name bytes', async () => {
		const f = fixture();
		f.channels([
			{ id: 'channel-1', number: '1', name: 'One "bad"\r\n\\name' },
			{ id: 'channel-2', number: '2', name: 'Two' },
		]);
		f.segments([segment(), segment({ channelId: 'channel-2', id: 'airing-2' })]);
		await f.reporter.refresh();
		const identities = f.requests.map(request => request.init.headers!.Authorization!.match(/DeviceId="([^"]+)"/)![1]);
		expect(new Set(identities).size).toBe(2);
		expect(f.requests[0]!.init.headers!.Authorization).not.toMatch(/[\r\n\\]/);
		await f.reporter.refresh();
		expect(f.requests[2]!.init.headers!.Authorization).toBe(f.requests[0]!.init.headers!.Authorization);
		await f.reporter.close();
	});

	it('keeps the airing session across display-name edits and replaces changed credentials in order', async () => {
		const f = fixture();
		await f.reporter.refresh();
		f.connections([{ ...f.connection, name: 'Renamed' }]);
		await f.reporter.refresh();
		expect(f.requests[1]!.url).toMatch(/\/Progress$/);
		f.connections([{ ...f.connection, accessToken: 'replacement-token' }]);
		await f.reporter.refresh();
		expect(f.requests[2]!.url).toMatch(/\/Stopped$/);
		expect(f.requests[2]!.init.headers!.Authorization).toContain('synthetic-secret');
		expect(f.requests[3]!.url).toMatch(/\/Playing$/);
		expect(f.requests[3]!.init.headers!.Authorization).toContain('replacement-token');
		await f.reporter.close();
	});

	it('sends one stop when a channel disappears, reporting is disabled, or fallback starts', async () => {
		for (const reason of ['inactive', 'disabled', 'fallback', 'exit']) {
			const f = fixture();
			await f.reporter.refresh();
			if (reason === 'disabled') {
				f.connections([]);
			}
			else if (reason === 'fallback') {
				f.segments([segment({ playbackPath: '/media/fallback.mp4', role: 'dead-air' })]);
			}
			else {
				f.channels([]);
			}
			await f.reporter.refresh();
			await f.reporter.refresh();
			await f.reporter.close();
			expect(f.requests.map(request => request.url)).toEqual([
				'https://jellyfin.example/root/Sessions/Playing', 'https://jellyfin.example/root/Sessions/Playing/Stopped',
			]);
		}
	});

	it('does no timeline reads when opted out, or any reads without active channels', async () => {
		const f = fixture();
		f.connections([]);
		await f.reporter.refresh();
		expect(f.requests).toEqual([]);
		expect(f.listSegments).not.toHaveBeenCalled();
		f.channels([]);
		f.listConnections.mockClear();
		await f.reporter.refresh();
		expect(f.listConnections).not.toHaveBeenCalled();
		await f.reporter.close();
	});

	it('coalesces slow reports, bounds their deadline, and never logs provider secrets', async () => {
		const f = fixture();
		vi.useRealTimers();
		vi.spyOn(Date, 'now').mockReturnValue(NOW);
		f.fetch.mockImplementationOnce(async (_url, init) => {
			await new Promise<void>((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(new Error('synthetic-secret'))));
			throw new Error('unreachable');
		});
		const first = f.reporter.refresh();
		expect(f.reporter.refresh()).toBe(first);
		await first;
		expect(f.fetch).toHaveBeenCalledTimes(1);
		expect(f.fetch.mock.calls[0]![1]!.signal!.aborted).toBe(true);
		expect(JELLYFIN_REPORT_TIMEOUT_MS).toBeLessThan(PLAYBACK_REPORT_INTERVAL_MS);
		expect(JSON.stringify(f.warn.mock.calls)).not.toContain('synthetic-secret');
		await f.reporter.refresh();
		expect(f.requests[0]!.url).toMatch(/\/Progress$/);
		await f.reporter.close();
	});

	it('cancels an in-flight report on shutdown and sends a final stop without leaving a timer', async () => {
		const f = fixture();
		f.fetch.mockImplementationOnce(async (_url, init) => {
			await new Promise<void>((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(new Error('cancelled'))));
			throw new Error('unreachable');
		});
		f.reporter.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(f.fetch).toHaveBeenCalledTimes(1);
		await f.reporter.close();
		expect(f.fetch.mock.calls[0]![1]!.signal!.aborted).toBe(true);
		expect(f.requests).toHaveLength(1);
		expect(f.requests[0]!.url).toMatch(/\/Stopped$/);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('reports file-relative positions for multipart sources and ignores mapped local playback', async () => {
		const f = fixture();
		f.segments([segment({
			playbackParts: [
				{ playbackPath: remotePlaybackReference(SERVER, 'first:first-source'), durationSeconds: 350 },
				{ playbackPath: remotePlaybackReference(SERVER, 'second:second-source'), durationSeconds: 400 },
			],
		})]);
		await f.reporter.refresh();
		expect(f.requests[0]!.body).toMatchObject({ ItemId: 'second', PositionTicks: 10 * 10_000_000 });
		f.segments([segment({ playbackPath: '/media/mapped.mkv' })]);
		await f.reporter.refresh();
		expect(f.requests).toHaveLength(2);
		expect(f.requests[1]!.url).toMatch(/\/Stopped$/);
		await f.reporter.close();
	});
});
