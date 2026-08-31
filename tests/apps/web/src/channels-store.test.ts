import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScheduleGuide } from '@moirai/shared';
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
