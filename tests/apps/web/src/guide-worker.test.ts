import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { GuideWorkerReply, GuideWorkerRequest } from '@web/guide-worker-protocol';
import type { ScheduleGuide } from '@moirai/shared';

const endpoint = { onmessage: null as unknown as (event: { data: GuideWorkerRequest }) => void, postMessage: vi.fn<(reply: GuideWorkerReply) => void>() };
const span = { id: 'span', channelId: 'channel', start: '2026-10-01T00:00:00Z', finish: '2026-10-01T01:00:00Z', role: 'primary', title: 'Movie' };
const guide = { startDate: '2026-10-01', days: 3, channels: [{ channelId: 'channel', preview: { segments: [span], issues: [] }, entries: [{ ...span, id: 'block', kind: 'block' }] }] };

beforeEach(async () => {
	vi.resetModules();
	endpoint.postMessage.mockClear();
	vi.stubGlobal('self', endpoint);
	vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => guide }));
	await import('@web/guide.worker');
});
afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

async function load(id = 1) {
	endpoint.onmessage({ data: { id, kind: 'load', url: '/api/v1/schedule-guide' } });
	await vi.waitFor(() => expect(endpoint.postMessage).toHaveBeenCalledWith(expect.objectContaining({ id })));
}

it('returns compact summaries and retrieves indexed block spans only for the requested viewport', async () => {
	await load();
	const summary = endpoint.postMessage.mock.calls[0]![0];
	expect(summary.guide?.channels[0]?.preview.segments).toEqual([]);
	expect(summary.guide?.channels[0]?.entries).toEqual([]);
	const range = { minimumDuration: 0, channelIds: ['channel'], start: Date.parse(span.start), finish: Date.parse(span.finish) };
	endpoint.onmessage({ data: { id: 2, kind: 'query', snapshot: 1, range } });
	expect(endpoint.postMessage.mock.lastCall?.[0].listings).toEqual([['channel', [{ ...span, id: 'block', kind: 'block' }]]]);
	endpoint.onmessage({ data: { id: 3, kind: 'query', snapshot: 1, range: { ...range, segmentsOnly: true } } });
	expect(endpoint.postMessage.mock.lastCall?.[0].listings).toEqual([['channel', [span]]]);
	endpoint.onmessage({ data: { id: 4, kind: 'query', snapshot: 1, range: { ...range, start: range.finish, finish: range.finish + 1 } } });
	expect(endpoint.postMessage.mock.lastCall?.[0].listings).toEqual([['channel', []]]);
});

it('includes an overrun item’s earlier anchor without duplicating it or leaking other channels', async () => {
	const anchor = { ...span, id: 'anchor', start: '2026-10-01T19:00:00Z', finish: '2026-10-01T19:10:00Z' };
	const resumed = { ...span, id: 'resumed', start: '2026-10-01T20:00:00Z', finish: '2026-10-01T20:30:00Z' };
	vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => ({ ...guide, channels: [
		{ ...guide.channels[0], preview: { segments: [anchor, resumed], issues: [] } },
		{ channelId: 'other', preview: { segments: [{ ...span, id: 'foreign' }], issues: [] } },
	] }) } as Response);
	await load();
	const range = { channelIds: ['channel'], start: Date.parse(resumed.start), finish: Date.parse(resumed.finish),
		minimumDuration: 0, segmentsOnly: true, includeSegmentId: anchor.id };
	endpoint.onmessage({ data: { id: 2, kind: 'query', snapshot: 1, range } });
	expect(endpoint.postMessage.mock.lastCall?.[0].listings).toEqual([['channel', [resumed, anchor]]]);
	endpoint.onmessage({ data: { id: 3, kind: 'query', snapshot: 1, range: { ...range, includeSegmentId: resumed.id } } });
	expect(endpoint.postMessage.mock.lastCall?.[0].listings).toEqual([['channel', [resumed]]]);
	endpoint.onmessage({ data: { id: 4, kind: 'query', snapshot: 1, range: { ...range, includeSegmentId: 'foreign' } } });
	expect(endpoint.postMessage.mock.lastCall?.[0].listings).toEqual([['channel', [resumed]]]);
});

it('rejects superseded snapshot queries and releases authenticated listings on clear', async () => {
	await load();
	await load(2);
	const range = { minimumDuration: 0, channelIds: ['channel'], start: Date.parse(span.start), finish: Date.parse(span.finish) };
	endpoint.onmessage({ data: { id: 3, kind: 'query', snapshot: 1, range } });
	expect(endpoint.postMessage.mock.lastCall?.[0]).toMatchObject({ snapshot: 2, listings: [] });
	endpoint.onmessage({ data: { id: 4, kind: 'clear' } });
	endpoint.onmessage({ data: { id: 5, kind: 'query', snapshot: 2, range } });
	expect(endpoint.postMessage.mock.lastCall?.[0]).toMatchObject({ snapshot: 0, listings: [] });
});

it('preserves authentication failure facts without publishing a successful snapshot', async () => {
	const body = { code: 'authentication_required', message: 'Sign in required' };
	vi.mocked(fetch).mockResolvedValue({ ok: false, status: 401, json: async () => body } as Response);
	endpoint.onmessage({ data: { id: 1, kind: 'load', url: '/api/v1/schedule-guide' } });
	await vi.waitFor(() => expect(endpoint.postMessage).toHaveBeenCalledWith({ id: 1, error: { name: 'ApiError', message: body.message, status: 401, body } }));
});

it('summarizes retained segments for a rolling window, including clipped and adjacent dead air', async () => {
	const spans = [
		{ ...span, start: '2026-10-01T00:00:00Z', finish: '2026-10-01T01:00:00Z' },
		{ ...span, id: 'gap-one', role: 'dead-air', start: '2026-10-01T01:00:00Z', finish: '2026-10-01T02:00:00Z' },
		{ ...span, id: 'gap-two', role: 'dead-air', start: '2026-10-01T02:00:00Z', finish: '2026-10-01T03:00:00Z' },
		{ ...span, id: 'later', start: '2026-10-02T00:00:00Z', finish: '2026-10-02T01:00:00Z' },
	];
	vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => ({ ...guide, channels: [
		{ ...guide.channels[0], preview: { segments: spans, issues: [] } },
		{ channelId: 'empty', preview: { segments: [], issues: [] } },
	] }) } as Response);
	await load();
	expect(endpoint.postMessage.mock.lastCall?.[0].guide?.channels[0]?.preview.segments).toEqual([]);
	const window = { start: Date.parse('2026-10-01T00:30:00Z'), finish: Date.parse('2026-10-01T02:30:00Z'), startDate: '2026-10-01', days: 1, timeZone: 'UTC' };
	endpoint.onmessage({ data: { id: 2, kind: 'summaries', snapshot: 1, window } });
	expect(endpoint.postMessage.mock.lastCall?.[0].summaries).toEqual([
		['channel', { gapCount: 1, deadAirSeconds: 5400, programmedCount: 1 }],
		['empty', { gapCount: 0, deadAirSeconds: 0, programmedCount: 0 }],
	]);
	endpoint.onmessage({ data: { id: 3, kind: 'summaries', snapshot: 1, window: {
		...window, start: Date.parse('2026-10-02T00:00:00Z'), finish: Date.parse('2026-10-03T00:00:00Z'),
	} } });
	expect(endpoint.postMessage.mock.lastCall?.[0].summaries?.[0]?.[1]).toEqual({ gapCount: 0, deadAirSeconds: 0, programmedCount: 1 });
	await load(4);
	endpoint.onmessage({ data: { id: 5, kind: 'summaries', snapshot: 1, window } });
	expect(endpoint.postMessage.mock.lastCall?.[0]).toMatchObject({ snapshot: 4, summaries: [] });
	endpoint.onmessage({ data: { id: 6, kind: 'clear' } });
	endpoint.onmessage({ data: { id: 7, kind: 'summaries', snapshot: 4, window } });
	expect(endpoint.postMessage.mock.lastCall?.[0]).toMatchObject({ snapshot: 0, summaries: [] });
});

it('exposes the same summary through the client for compact worker guides and full fallback guides', async () => {
	class TestWorker {
		onmessage: ((event: { data: GuideWorkerReply }) => void) | null = null;
		constructor() {
			endpoint.postMessage.mockImplementation(reply => {
				queueMicrotask(() => this.onmessage?.({ data: reply }));
			});
		}
		postMessage(request: GuideWorkerRequest) {
			endpoint.onmessage({ data: request });
		}
	}
	vi.stubGlobal('Worker', TestWorker);
	const { loadWorkerGuide, queryGuideSummaries, clearWorkerGuide } = await import('@web/guide-worker');
	const compact = await loadWorkerGuide('/fixture');
	const window = { start: Date.parse(span.start), finish: Date.parse(span.finish), startDate: '2026-10-01', days: 1, timeZone: 'UTC' };
	expect(compact.channels[0]?.preview.segments).toEqual([]);
	const workerSummary = await queryGuideSummaries(compact, window);
	expect(workerSummary.get('channel')).toEqual({ gapCount: 0, deadAirSeconds: 0, programmedCount: 1 });
	expect(await queryGuideSummaries(guide as unknown as ScheduleGuide, window)).toEqual(workerSummary);
	await clearWorkerGuide();
	await expect(queryGuideSummaries(compact, window)).rejects.toMatchObject({ name: 'AbortError' });
});

it.each([
	{ scenario: 'progressive initial load', days: 3, refresh: false },
	{ scenario: 'refresh with a delayed status failure', days: 1, refresh: true },
])('keeps the accepted worker guide queryable after a status failure during $scenario', async ({ days, refresh }) => {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(new Date('2026-10-01T12:00:00Z'));
	class TestWorker {
		onmessage: ((event: { data: GuideWorkerReply }) => void) | null = null;
		constructor() {
			endpoint.postMessage.mockImplementation(reply => {
				queueMicrotask(() => this.onmessage?.({ data: reply }));
			});
		}
		postMessage(request: GuideWorkerRequest) {
			endpoint.onmessage({ data: request });
		}
	}
	vi.stubGlobal('Worker', TestWorker);
	vi.mocked(fetch).mockImplementation(async url => ({ ok: true, json: async () => ({
		...guide, timeZone: 'UTC', days: Number(new URL(String(url), 'https://localhost').searchParams.get('days')),
	}) }) as Response);
	const { createPinia, setActivePinia } = await import('pinia');
	const { api } = await import('@web/api');
	const { useChannelsStore } = await import('@web/stores/channels');
	const { queryWorkerGuide, queryGuideSummaries } = await import('@web/guide-worker');
	setActivePinia(createPinia());
	const store = useChannelsStore();
	const statuses = vi.spyOn(api, 'timelineMaterializations').mockResolvedValue([]);
	if (refresh) {
		await store.loadGuide(guide.startDate, 1);
	}
	const previous = store.guide;
	const failure = new Error('Status request unavailable');
	let rejectStatuses!: (error: Error) => void;
	if (refresh) {
		statuses.mockImplementationOnce(() => new Promise((_, reject) => {
			rejectStatuses = reject;
		}));
	}
	else {
		statuses.mockRejectedValueOnce(failure);
	}
	const replies = endpoint.postMessage.mock.calls.length;
	const completion = store.loadGuide(guide.startDate, days).catch(error => error);
	if (refresh) {
		await vi.waitFor(() => expect(endpoint.postMessage.mock.calls.slice(replies).some(([reply]) => reply.guide)).toBe(true));
		rejectStatuses(failure);
	}

	expect(await completion).toBe(failure);
	expect(store.guide).not.toBe(previous);
	expect(store.guideLoaded).toBe(true);
	expect(store.guideDays).toBe(days);
	expect(store.guideError).toBe(failure.message);
	expect(store.guideRefreshing).toBe(false);
	const window = { start: Date.parse(span.start), finish: Date.parse(span.finish), startDate: guide.startDate, days: 1, timeZone: 'UTC' };
	const listings = await queryWorkerGuide(store.guide!, { ...window, channelIds: ['channel'], minimumDuration: 0 });
	expect(listings.get('channel')).toEqual([{ ...span, id: 'block', kind: 'block' }]);
	const spans = await queryWorkerGuide(store.guide!, { ...window, channelIds: ['channel'], minimumDuration: 0, segmentsOnly: true });
	expect(spans.get('channel')).toEqual([span]);
	expect((await queryGuideSummaries(store.guide!, window)).get('channel')).toEqual({ gapCount: 0, deadAirSeconds: 0, programmedCount: 1 });
	statuses.mockRestore();
});

it('discards an older fetch even when the mocked transport ignores its abort signal', async () => {
	let resolve!: (response: Response) => void;
	vi.mocked(fetch).mockImplementationOnce(() => new Promise<Response>(complete => {
		resolve = complete; 
	}));
	endpoint.onmessage({ data: { id: 1, kind: 'load', url: '/api/v1/schedule-guide' } });
	await load(2);
	resolve({ ok: true, json: async () => guide } as Response);
	await vi.waitFor(() => expect(endpoint.postMessage).toHaveBeenCalledWith(expect.objectContaining({ id: 1, error: expect.objectContaining({ name: 'AbortError' }) })));
	endpoint.onmessage({ data: { id: 3, kind: 'query', snapshot: 2, range: { channelIds: ['channel'], start: Date.parse(span.start), finish: Date.parse(span.finish), minimumDuration: 0 } } });
	expect(endpoint.postMessage.mock.lastCall?.[0].listings?.[0]?.[1]).toHaveLength(1);
});
