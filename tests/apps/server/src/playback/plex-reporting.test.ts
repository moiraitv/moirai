import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import { remotePlaybackReference, type TimelineSegment } from '@moirai/shared';
import { MediaServerPlaybackReporter, type ReportingChannel } from '@server/playback/media-server-reporting.js';
import { PLEX_REPORT_INTERVAL_MS } from '@server/media-servers/plex-playback-client.js';
import type { MediaFetchInit } from '@server/media-servers/http.js';
import type { Repository } from '@server/repository/index.js';
import type { MediaServerConnectionRecord } from '@server/repository/media-servers.js';

const NOW = Date.parse('2026-11-16T22:00:00Z');
const SERVER = '11111111-1111-4111-8111-111111111111';

function segment(overrides: Partial<TimelineSegment> = {}): TimelineSegment {
	return {
		id: 'airing-1', channelId: 'channel-1', role: 'primary', scheduleLayerId: null,
		templateId: 'template', slotId: 'slot', programId: 'program', mediaItemId: 'media',
		title: 'Movie', playbackPath: remotePlaybackReference(SERVER, 'part-1'),
		start: new Date(NOW - 60_000).toISOString(), finish: new Date(NOW + 120_000).toISOString(),
		sourceStartSeconds: 300, sourceFinishSeconds: 480, truncated: true, ...overrides,
	};
}

function fixture() {
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
	const connection: MediaServerConnectionRecord = {
		id: SERVER, provider: 'plex', name: 'Plex', baseUrl: 'https://plex.example/root',
		serverKey: 'server', serverName: 'Plex', clientIdentifier: 'saved-device',
		accessToken: 'synthetic-secret', allowInsecureTls: false, playbackReportingEnabled: true, pathReplacements: [],
	};
	let channels: ReportingChannel[] = [{ id: 'channel-1', number: '700.2', name: 'Plex Test' }];
	let segments = [segment()];
	let connections = [connection];
	let items = [{ id: 'media', serverId: SERVER, ratingKey: '42', durationMilliseconds: 900_000 as number | null }];
	const requests: Array<{ url: URL; init: MediaFetchInit }> = [];
	const warn = vi.fn();
	const fetch = vi.fn(async (url: string, init?: MediaFetchInit) => {
		requests.push({ url: new URL(url), init: init! });
		return { ok: true, status: 200, headers: { get: () => null }, body: null, text: async () => '', arrayBuffer: async () => new ArrayBuffer(0) };
	});
	const listConnections = vi.fn(async () => connections);
	const listItems = vi.fn(async () => items);
	const listSegments = vi.fn(async () => segments.map(segment => ({ segment, mediaSnapshot: null, stateDelta: [] })));
	const repository = {
		mediaServers: { playbackReportingConnections: listConnections, plexPlaybackItems: listItems },
		listCurrentPlaybackSegments: listSegments,
	} as unknown as Repository;
	const reporter = new MediaServerPlaybackReporter(repository, () => channels, { warn } as unknown as FastifyBaseLogger, () => fetch);
	return {
		reporter, requests, fetch, warn, connection, listConnections, listItems, listSegments,
		channels: (value: ReportingChannel[]) => {
			channels = value; 
		},
		segments: (value: TimelineSegment[]) => {
			segments = value; 
		},
		connections: (value: MediaServerConnectionRecord[]) => {
			connections = value; 
		},
		items: (value: typeof items) => {
			items = value; 
		},
	};
}

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe('Plex channel reporting', () => {
	it('resolves rating keys from part ids and reports live cropped positions every ten seconds', async () => {
		const f = fixture();
		f.reporter.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(f.listItems).toHaveBeenCalledWith(['media']);
		expect(Object.fromEntries(f.requests[0]!.url.searchParams)).toMatchObject({
			ratingKey: '42', time: '360000', duration: '900000', state: 'playing',
		});
		const session = f.requests[0]!.init.headers!['X-Plex-Session-Identifier'];
		await vi.advanceTimersByTimeAsync(PLEX_REPORT_INTERVAL_MS);
		expect(f.requests[1]!.url.searchParams.get('time')).toBe('370000');
		expect(f.requests[1]!.init.headers!['X-Plex-Session-Identifier']).toBe(session);
		await f.reporter.close();
		expect(f.requests[2]!.url.searchParams.get('state')).toBe('stopped');
		expect(vi.getTimerCount()).toBe(0);
	});

	it('stops at a cropped broadcast boundary before reporting the next airing', async () => {
		const f = fixture();
		f.segments([segment({ finish: new Date(NOW + 2_000).toISOString(), sourceFinishSeconds: 362 })]);
		f.reporter.start();
		await vi.advanceTimersByTimeAsync(0);
		f.segments([segment({ id: 'airing-2', start: new Date(NOW + 2_000).toISOString(), sourceStartSeconds: 0 })]);
		await vi.advanceTimersByTimeAsync(2_000);
		expect(f.requests.map(request => request.url.searchParams.get('state'))).toEqual(['playing', 'stopped', 'playing']);
		expect(f.requests[1]!.url.searchParams.get('time')).toBe('362000');
		expect(f.requests[2]!.url.searchParams.get('time')).toBe('0');
		expect(f.requests[2]!.init.headers!['X-Plex-Session-Identifier']).not.toBe(f.requests[0]!.init.headers!['X-Plex-Session-Identifier']);
		await f.reporter.close();
	});

	it('retains one item-relative session through a multipart file boundary', async () => {
		const f = fixture();
		const parts = [
			{ playbackPath: remotePlaybackReference(SERVER, 'part-1'), durationSeconds: 370 },
			{ playbackPath: remotePlaybackReference(SERVER, 'part-2'), durationSeconds: 530 },
		];
		f.segments([segment({ playbackParts: parts })]);
		await f.reporter.refresh();
		vi.setSystemTime(NOW + 20_000);
		await f.reporter.refresh();
		expect(f.requests.map(request => request.url.searchParams.get('time'))).toEqual(['360000', '380000']);
		expect(f.requests.every(request => request.url.searchParams.get('state') === 'playing')).toBe(true);
		expect(f.requests[1]!.init.headers!['X-Plex-Session-Identifier']).toBe(f.requests[0]!.init.headers!['X-Plex-Session-Identifier']);
		await f.reporter.close();
	});

	it('isolates simultaneous channels while batching source resolution and skipping unsafe attribution', async () => {
		const f = fixture();
		f.channels([{ id: 'channel-1', number: '1', name: 'One' }, { id: 'channel-2', number: '2', name: 'Two' }]);
		f.segments([segment(), segment({ channelId: 'channel-2', id: 'airing-2' })]);
		await f.reporter.refresh();
		expect(f.listItems).toHaveBeenCalledOnce();
		expect(f.listItems).toHaveBeenCalledWith(['media']);
		expect(new Set(f.requests.map(request => request.init.headers!['X-Plex-Client-Identifier'])).size).toBe(2);
		f.items([{ id: 'media', serverId: 'different-server', ratingKey: '42', durationMilliseconds: 900_000 }]);
		await f.reporter.refresh();
		expect(f.requests.slice(2).map(request => request.url.searchParams.get('state'))).toEqual(['stopped', 'stopped']);
		await f.reporter.close();
	});

	it('does no reporting reads without viewers and no timeline reads when opted out', async () => {
		const f = fixture();
		f.channels([]);
		await f.reporter.refresh();
		expect(f.listConnections).not.toHaveBeenCalled();
		f.channels([{ id: 'channel-1', number: '1', name: 'One' }]);
		f.connections([]);
		await f.reporter.refresh();
		expect(f.listSegments).not.toHaveBeenCalled();
		expect(f.listItems).not.toHaveBeenCalled();
		expect(f.requests).toEqual([]);
		await f.reporter.close();
	});

	it.each(['inactive', 'disabled', 'local', 'fallback', 'missing', 'duration'])('stops once on %s and does not restart an invalid target', async (reason) => {
		const f = fixture();
		await f.reporter.refresh();
		if (reason === 'inactive') {
			f.channels([]); 
		}
		else if (reason === 'disabled') {
			f.connections([]); 
		}
		else if (reason === 'local') {
			f.segments([segment({ playbackPath: '/mapped/file.mkv' })]); 
		}
		else if (reason === 'fallback') {
			f.segments([segment({ role: 'dead-air' })]); 
		}
		else if (reason === 'missing') {
			f.items([]); 
		}
		else {
			f.items([{ id: 'media', serverId: SERVER, ratingKey: '42', durationMilliseconds: null }]); 
		}
		await f.reporter.refresh();
		await f.reporter.refresh();
		await f.reporter.close();
		expect(f.requests.map(request => request.url.searchParams.get('state'))).toEqual(['playing', 'stopped']);
	});

	it('coalesces slow reports, cancels on shutdown, and keeps provider secrets out of logs', async () => {
		const f = fixture();
		f.fetch.mockImplementationOnce(async (_url, init) => {
			await new Promise<void>((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(new Error('synthetic-secret'))));
			throw new Error('unreachable');
		});
		f.reporter.start();
		await vi.advanceTimersByTimeAsync(0);
		const first = f.reporter.refresh();
		expect(f.reporter.refresh()).toBe(first);
		await f.reporter.close();
		expect(f.fetch).toHaveBeenCalledTimes(2);
		expect(f.fetch.mock.calls[0]![1]!.signal!.aborted).toBe(true);
		expect(f.requests[0]!.url.searchParams.get('state')).toBe('stopped');
		expect(JSON.stringify(f.warn.mock.calls)).not.toContain('synthetic-secret');
		expect(vi.getTimerCount()).toBe(0);
	});
});
