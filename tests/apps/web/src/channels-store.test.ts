import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
	setActivePinia(createPinia());
	vi.restoreAllMocks();
});

describe('channel guide navigation', () => {
	it('returns to the exact prior boundary when adaptive page lengths differ', async () => {
		vi.spyOn(api, 'scheduleGuide').mockImplementation(async (startDate, requestedDays) =>
			guide(startDate, requestedDays ?? 7, startDate === '2026-08-01' ? 3 : 7));
		const store = useChannelsStore();

		await store.loadGuide('2026-08-01', 7);
		expect(store.guideNavigationTarget('forward')).toBe('2026-08-04');

		await store.loadGuide('2026-08-04', 7, 'forward');
		expect(store.guideNavigationTarget('backward')).toBe('2026-08-01');

		await store.loadGuide('2026-08-01', 7, 'backward');
		expect(store.guideNavigationTarget('backward')).toBeNull();
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
