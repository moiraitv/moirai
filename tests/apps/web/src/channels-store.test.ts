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
	vi.restoreAllMocks();
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
		['channels', (store: ReturnType<typeof useChannelsStore>) => store.loadChannels()],
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
