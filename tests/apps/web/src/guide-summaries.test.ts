import { afterEach, expect, it, vi } from 'vitest';
import { effectScope, nextTick, shallowRef } from 'vue';
import type { ScheduleGuide } from '@moirai/shared';
import { useGuideSummaries } from '@web/guide-summaries';
import { queryGuideSummaries } from '@web/guide-worker';
import type { ScheduleDaySummary } from '@web/channel-schedule-preview';

vi.mock('@web/guide-worker', () => ({ queryGuideSummaries: vi.fn() }));
afterEach(() => vi.resetAllMocks());

const window = { start: 0, finish: 86400000, startDate: '1970-01-01', days: 1, timeZone: 'UTC' };
const guide: ScheduleGuide = { startDate: '1970-01-01', days: 1, requestedDays: 1, segmentLimitApplied: false, timeZone: 'UTC', channels: [] };

it('keeps pending summaries distinct from empty and ignores superseded responses', async () => {
	const completions: Array<(value: Map<string, ScheduleDaySummary>) => void> = [];
	vi.mocked(queryGuideSummaries).mockImplementation(() => new Promise(resolve => completions.push(resolve)));
	const snapshot = shallowRef<ScheduleGuide | null>(guide);
	const range = shallowRef(window);
	const scope = effectScope();
	const state = scope.run(() => useGuideSummaries(() => snapshot.value, () => range.value, () => true))!;
	try {
		expect(state.loading.value).toBe(true);
		expect(state.summaries.value.size).toBe(0);
		range.value = { ...window, start: 1000 };
		await nextTick();
		completions[0]!(new Map([['obsolete', { gapCount: 0, deadAirSeconds: 0, programmedCount: 1 }]]));
		await nextTick();
		expect(state.loading.value).toBe(true);
		expect(state.summaries.value.size).toBe(0);
		const result = new Map([['channel', { gapCount: 1, deadAirSeconds: 3600, programmedCount: 1 }]]);
		completions[1]!(result);
		await nextTick();
		expect(state.summaries.value).toEqual(result);
		expect(state.loading.value).toBe(false);
		expect(queryGuideSummaries).toHaveBeenLastCalledWith(guide, range.value);
		snapshot.value = { ...guide };
		await nextTick();
		scope.stop();
		completions[2]!(new Map());
		await nextTick();
		expect(state.loading.value).toBe(true);
	}
	finally {
		scope.stop();
	}
});

it('reports failed queries instead of successful zero counts', async () => {
	vi.mocked(queryGuideSummaries).mockRejectedValue(new Error('Worker unavailable'));
	const scope = effectScope();
	const state = scope.run(() => useGuideSummaries(() => guide, () => window, () => true))!;
	try {
		await nextTick();
		expect(state.loading.value).toBe(false);
		expect(state.error.value).toBe('Worker unavailable');
		expect(state.summaries.value.size).toBe(0);
	}
	finally {
		scope.stop();
	}
});
