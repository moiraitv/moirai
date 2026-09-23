import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { channelSchema } from '@moirai/shared/api-contracts';
import type { Channel, ScheduleGuide } from '@moirai/shared';
import { api } from '@web/api.js';
import { useChannelsStore } from '@web/stores/channels.js';

/** Build one committed guide response with a controllable returned range. */
function guide(startDate: string, requestedDays: number, days: number): ScheduleGuide {
	return {
		timeZone: 'UTC',
		startDate,
		requestedDays,
		days,
		segmentLimitApplied: days < requestedDays,
		committedStartDate: '2026-08-01',
		committedEndDate: '2026-08-15',
		channels: [],
	};
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(new Date('2026-08-01T12:00:00Z'));
	setActivePinia(createPinia());
	useChannelsStore().guideHorizonDays = 14;
	vi.restoreAllMocks();
	vi.spyOn(api, 'timelineMaterializations').mockResolvedValue([]);
});

afterEach(() => vi.useRealTimers());

describe('channel guide navigation', () => {
	it('returns to the exact prior boundary when adaptive page lengths differ', async () => {
		vi.spyOn(api, 'scheduleGuide').mockImplementation(async (startDate, requestedDays) =>
			guide(startDate, requestedDays ?? 7, startDate === '2026-08-01' ? 3 : 7));
		const store = useChannelsStore();

		await store.loadGuide('2026-08-01', 7);
		expect(vi.mocked(api.scheduleGuide).mock.calls.slice(0, 2)).toEqual([
			['2026-08-01', 1],
			['2026-08-01', 7],
		]);
		expect(store.guideNavigationTarget('forward')).toBe('2026-08-04');

		await store.loadGuide('2026-08-04', 7, 'forward');
		expect(store.guideNavigationTarget('backward')).toBe('2026-08-01');

		await store.loadGuide('2026-08-01', 7, 'backward');
		expect(store.guideNavigationTarget('backward')).toBeNull();
	});

	it('exposes a one-day guide before the remainder of the week arrives', async () => {
		let releaseWeek: (() => void) | undefined;
		vi.spyOn(api, 'scheduleGuide').mockImplementation(async (startDate, requestedDays) => {
			if ((requestedDays ?? 7) > 1) {
				await new Promise<void>((resolve) => {
					releaseWeek = resolve;
				});
			}

			return guide(startDate, requestedDays ?? 7, requestedDays ?? 7);
		});
		const store = useChannelsStore();
		const pending = store.loadGuide('2026-08-01', 7);
		await vi.waitFor(() => {
			expect(store.guideLoaded).toBe(true);
			expect(store.guideDays).toBe(1);
		});
		expect(store.guideNavigationTarget('forward')).toBe('2026-08-08');
		releaseWeek?.();
		await pending;
		expect(store.guideDays).toBe(7);
	});

	it('clamps backward navigation when no in-memory history is available', async () => {
		vi.spyOn(api, 'scheduleGuide').mockResolvedValue(guide('2026-08-04', 7, 7));
		const store = useChannelsStore();

		await store.loadGuide('2026-08-04', 7);

		expect(store.guideNavigationTarget('backward')).toBe('2026-08-01');
	});
});


describe('server-confirmed channel saves', () => {
	it('inserts new channels and replaces edits without duplicating them', () => {
		const store = useChannelsStore();
		const channel = channelSchema.parse({ id: '00000000-0000-4000-8000-000000000001', number: '10', name: 'Saved channel', createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-08-01T00:00:00Z' });

		store.acceptSavedChannel(channel);
		expect(store.channels).toEqual([channel]);
		store.acceptSavedChannel({ ...channel, name: 'Edited channel' });
		expect(store.channels).toEqual([{ ...channel, name: 'Edited channel' }]);
	});

	it('ignores a catalog response started before the save and allows subsequent refreshes', async () => {
		let resolveCatalog!: (channels: Channel[]) => void;
		vi.spyOn(api, 'channels').mockImplementationOnce(() => new Promise(resolve => {
			resolveCatalog = resolve;
		}));
		const store = useChannelsStore();
		const channel = channelSchema.parse({ id: '00000000-0000-4000-8000-000000000001', number: '10', name: 'Saved channel', createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-08-01T00:00:00Z' });
		const loading = store.loadChannels();

		store.acceptSavedChannel(channel);
		resolveCatalog([]);
		await loading;
		expect(store.channels).toEqual([channel]);

		vi.mocked(api.channels).mockResolvedValue([{ ...channel, name: 'Refreshed channel' }]);
		await store.loadChannels();
		expect(store.channels[0]?.name).toBe('Refreshed channel');
	});
});


it('advances stale requests in the scheduling time zone and drops expired navigation history', async () => {
	const request = vi.spyOn(api, 'scheduleGuide').mockImplementation(async (start, days) => guide(start, days ?? 7, days ?? 7));
	const store = useChannelsStore();
	store.timeZone = 'America/Los_Angeles';
	await store.loadGuide('2026-08-01', 7);
	await store.loadGuide('2026-08-08', 7, 'forward');
	vi.setSystemTime(new Date('2026-08-02T06:59:00Z'));
	await store.loadGuide('2026-08-01', 2);
	expect(request).toHaveBeenLastCalledWith('2026-08-01', 2);
	vi.setSystemTime(new Date('2026-08-02T07:01:00Z'));
	await store.loadGuide('2026-08-01', 2);
	expect(request).toHaveBeenLastCalledWith('2026-08-02', 7);
	expect(store.guideWeekStart).toBe('2026-08-02');
	await store.loadGuide('2026-08-08', 7);
	expect(request).toHaveBeenLastCalledWith('2026-08-08', 7);
	expect(store.guideNavigationTarget('backward')).not.toBe('2026-08-01');
});

it('does not propagate failures superseded by newer channel, capability, or guide requests', async () => {
	for (const [method, load] of [
		['channels', (store: ReturnType<typeof useChannelsStore>) => store.loadChannels(true)],
		['capabilities', (store: ReturnType<typeof useChannelsStore>) => store.loadCapabilities()],
		['scheduleGuide', (store: ReturnType<typeof useChannelsStore>) => store.loadGuide('2026-08-01')],
	] as const) {
		const store = useChannelsStore();
		let reject!: (cause: Error) => void;
		const request = vi.spyOn(api, method).mockImplementationOnce(() => new Promise<never>((_, fail) => {
			reject = fail;
		}));
		const result = method === 'channels' ? [] : method === 'scheduleGuide' ? guide('2026-08-01', 7, 7) : { timeZone: 'UTC' };
		request.mockResolvedValue(result as never);
		const older = load(store);
		await load(store);
		reject(new TypeError('Old request failed'));
		await expect(older).resolves.toBeUndefined();
		expect(store.error).toBe('');
		request.mockRejectedValue(new TypeError('Current request failed'));
		await expect(load(store)).rejects.toThrow('Current request failed');
		request.mockRestore();
	}
});

it('shares route bootstrap reads but lets live refresh supersede an in-flight snapshot', async () => {
	let resolve!: (value: ScheduleGuide) => void;
	const request = vi.spyOn(api, 'scheduleGuide').mockImplementationOnce(() => new Promise(done => {
		resolve = done;
	}));
	const store = useChannelsStore();
	const first = store.loadGuide('2026-08-01', 1, 'preserve', true);
	const second = store.loadGuide('2026-08-01', 1, 'preserve', true);
	expect(request).toHaveBeenCalledTimes(1);
	const fresh = guide('2026-08-01', 1, 1);
	fresh.committedAt = '2026-08-01T12:00:00Z';
	request.mockResolvedValue(fresh);
	await store.loadGuide('2026-08-01', 1);
	resolve(guide('2026-08-01', 1, 1));
	await Promise.all([first, second]);
	expect(store.guide).toBe(fresh);
	expect(store.guide?.channels).toBe(fresh.channels);
	await store.loadGuide('2026-08-01', 1, 'preserve', true);
	expect(request).toHaveBeenCalledTimes(3);
});

it('shares the remaining week after a progressive first day and retries a failed shared request', async () => {
	let rejectWeek!: (error: Error) => void;
	const request = vi.spyOn(api, 'scheduleGuide').mockImplementation(async (start, days) => {
		if (days === 1) {
			return guide(start, 1, 1);
		}
		return new Promise<ScheduleGuide>((_, reject) => {
			rejectWeek = reject;
		});
	});
	const store = useChannelsStore();
	const first = store.loadGuide('2026-08-01', 7, 'preserve', true);
	await vi.waitFor(() => expect(store.guideDays).toBe(1));
	const second = store.loadGuide('2026-08-01', 7, 'preserve', true);
	expect(request).toHaveBeenCalledTimes(2);
	const settled = Promise.allSettled([first, second]);
	rejectWeek(new Error('Week unavailable'));
	expect((await settled).map(result => result.status)).toEqual(['rejected', 'rejected']);
	expect(store.guideDays).toBe(1);
	expect(store.guideLoaded).toBe(true);
	request.mockResolvedValue(guide('2026-08-01', 7, 7));
	await store.loadGuide('2026-08-01', 7, 'preserve', true);
	expect(request).toHaveBeenCalledTimes(3);
	expect(store.guideDays).toBe(7);
	expect(store.error).toBe('');
});

it('retains cached guide content during refresh and distinguishes preparing and failed assigned rows', async () => {
	const store = useChannelsStore();
	const channel = channelSchema.parse({ id: '00000000-0000-4000-8000-000000000001', number: '1', name: 'Pending',
		createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-08-01T00:00:00Z' });
	store.acceptSavedChannel(channel);
	vi.mocked(api.timelineMaterializations).mockResolvedValue([{ channelId: channel.id, health: 'generating',
		windowStart: null, windowEnd: null, committedAt: null, pendingSince: null, applyAfter: null, lastError: null }]);
	const cached = guide('2026-08-01', 1, 1);
	vi.spyOn(api, 'scheduleGuide').mockResolvedValue(cached);
	await store.loadGuide('2026-08-01', 1);
	let finish!: (value: ScheduleGuide) => void;
	vi.mocked(api.scheduleGuide).mockImplementationOnce(() => new Promise(resolve => {
		finish = resolve;
	}));
	const pending = store.loadGuide('2026-08-01', 1);
	expect(store.guide).toBe(cached);
	expect(store.guideLoading).toBe(false);
	expect(store.guideRefreshing).toBe(true);
	expect(store.guideRowStates[channel.id]?.state).toBe('preparing');
	finish(cached);
	await pending;
	expect(store.guideRefreshing).toBe(false);
	vi.mocked(api.scheduleGuide).mockRejectedValueOnce(new Error('Generation failed'));
	await expect(store.loadGuide('2026-08-01', 1)).rejects.toThrow('Generation failed');
	expect(store.guide).toBe(cached);
	expect(store.guideRowStates[channel.id]).toMatchObject({ state: 'failed', message: 'Generation failed' });
	await store.loadGuide('2026-08-01', 1);
	expect(store.guideError).toBe('');
});

it('shares duplicate channel reads and immediately accepts a save over an older response', async () => {
	const store = useChannelsStore();
	let finish!: (value: Channel[]) => void;
	const request = vi.spyOn(api, 'channels').mockImplementation(() => new Promise(resolve => {
		finish = resolve;
	}));
	const a = store.loadChannels();
	const b = store.loadChannels();
	expect(request).toHaveBeenCalledTimes(1);
	const saved = channelSchema.parse({ id: '00000000-0000-4000-8000-000000000001', number: '1', name: 'Saved',
		createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-08-01T00:00:00Z' });
	store.acceptSavedChannel(saved);
	finish([]);
	await Promise.all([a, b]);
	expect(store.channels).toEqual([saved]);
});

it('loads the configured horizon from capabilities and bounds requests and navigation', async () => {
	vi.spyOn(api, 'capabilities').mockResolvedValue({ guideDays: 3, timeZone: 'UTC' } as Awaited<ReturnType<typeof api.capabilities>>);
	vi.spyOn(api, 'scheduleGuide').mockImplementation(async (startDate, days = 7) => ({
		...guide(startDate, days, days), committedEndDate: '2026-08-04',
	}));
	const store = useChannelsStore();
	await store.loadCapabilities();
	await store.loadGuide('2026-08-01', 7);
	expect(store.guideHorizonDays).toBe(3);
	expect(vi.mocked(api.scheduleGuide).mock.calls).toEqual([['2026-08-01', 1], ['2026-08-01', 3]]);
	expect(store.guideNavigationTarget('forward')).toBeNull();
	await store.loadGuide('2026-08-03', 7);
	expect(api.scheduleGuide).toHaveBeenLastCalledWith('2026-08-03', 1);
	await store.loadGuide('2026-08-10', 7);
	expect(api.scheduleGuide).toHaveBeenLastCalledWith('2026-08-01', 3);
});

it('refreshes stale capabilities before guide reads and retries a failed capabilities refresh', async () => {
	const capabilities = vi.spyOn(api, 'capabilities').mockResolvedValue({ guideDays: 7, timeZone: 'UTC' } as Awaited<ReturnType<typeof api.capabilities>>);
	const reads = vi.spyOn(api, 'scheduleGuide').mockImplementation(async (start, days = 7) => guide(start, days, days));
	const store = useChannelsStore();
	await store.loadCapabilities();
	await store.loadGuide('2026-08-01', 7);
	store.invalidateCapabilities();
	capabilities.mockRejectedValueOnce(new Error('Temporarily unavailable'));
	reads.mockClear();
	await expect(store.loadGuide('2026-08-01', 7)).rejects.toThrow('Temporarily unavailable');
	expect(reads).not.toHaveBeenCalled();
	expect(store.guideError).toBe('Temporarily unavailable');
	capabilities.mockResolvedValue({ guideDays: 3, timeZone: 'UTC' } as Awaited<ReturnType<typeof api.capabilities>>);
	await store.loadGuide('2026-08-01', 7);
	expect(reads).toHaveBeenCalledExactlyOnceWith('2026-08-01', 3);
	expect(store.guideError).toBe('');
	await store.loadGuide('2026-08-01', 7);
	expect(capabilities).toHaveBeenCalledTimes(3);
});
