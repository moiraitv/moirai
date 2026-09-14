import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reactive } from 'vue';
import type { ScheduleGuide } from '@moirai/shared';
import { SCHEDULE_SUMMARY_REFRESH_MS, useUpcomingScheduleGuide } from '@web/upcoming-schedule-guide';

const lifecycle = vi.hoisted(() => ({ mounted: [] as Array<() => void>, unmounted: [] as Array<() => void> }));
vi.mock('vue', async (original) => ({
	...await original<typeof import('vue')>(),
	onMounted: (callback: () => void) => lifecycle.mounted.push(callback),
	onBeforeUnmount: (callback: () => void) => lifecycle.unmounted.push(callback),
}));
vi.mock('@web/stores/channels', () => ({ useChannelsStore: () => store }));

const store = reactive({
	timeZone: 'America/Los_Angeles',
	guide: null as ScheduleGuide | null,
	loadGuide: vi.fn<(date: string, days: number) => Promise<void>>(),
});
const document = Object.assign(new EventTarget(), { visibilityState: 'visible' });

function guide(startDate: string, days: number, limited = false): ScheduleGuide {
	return {
		startDate, days, requestedDays: days, segmentLimitApplied: limited,
		timeZone: store.timeZone, channels: [],
	};
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date('2026-09-03T19:00:00Z'));
	vi.stubGlobal('document', document);
	document.visibilityState = 'visible';
	store.guide = null;
	store.loadGuide.mockReset().mockImplementation(async (date, days) => {
		store.guide = guide(date, days);
	});
});

afterEach(() => {
	lifecycle.unmounted.splice(0).forEach((unmount) => unmount());
	lifecycle.mounted.length = 0;
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe('upcoming guide refresh lifecycle', () => {
	it('reuses a covering week and advances the clock without polling', async () => {
		store.guide = guide('2026-09-01', 7);
		const summary = useUpcomingScheduleGuide(() => true);
		lifecycle.mounted.forEach((mount) => mount());
		await summary.load();
		const previousStart = summary.window.value.start;
		await vi.advanceTimersByTimeAsync(SCHEDULE_SUMMARY_REFRESH_MS);
		expect(summary.window.value.start).toBe(previousStart + SCHEDULE_SUMMARY_REFRESH_MS);
		expect(summary.status.value).toBe('ready');
		expect(store.loadGuide).not.toHaveBeenCalled();
	});

	it('requests the required dates and treats in-flight invalidations as covered by the response', async () => {
		let release!: () => void;
		store.loadGuide.mockImplementationOnce(async (date, days) => {
			await new Promise<void>((resolve) => release = resolve);
			store.guide = guide(date, days);
		});
		const summary = useUpcomingScheduleGuide(() => true);
		const initial = summary.load();
		expect(summary.status.value).toBe('loading');
		const concurrent = summary.load();
		const invalidated = summary.load(true);
		const again = summary.load(true);
		expect(store.loadGuide).toHaveBeenCalledTimes(1);
		release();
		await Promise.all([initial, concurrent, invalidated, again]);
		expect(store.loadGuide).toHaveBeenCalledTimes(1);
		expect(store.loadGuide).toHaveBeenLastCalledWith('2026-09-03', 2);
		expect(summary.status.value).toBe('ready');
	});

	it('reports incomplete coverage and does not repeatedly request a truncated range', async () => {
		store.loadGuide.mockImplementation(async (date) => {
			store.guide = guide(date, 1, true);
		});
		const summary = useUpcomingScheduleGuide(() => true);
		lifecycle.mounted.forEach((mount) => mount());
		await summary.load();
		expect(summary.status.value).toBe('incomplete');
		await vi.advanceTimersByTimeAsync(SCHEDULE_SUMMARY_REFRESH_MS * 3);
		expect(store.loadGuide).toHaveBeenCalledTimes(1);
		await summary.load(true);
		expect(store.loadGuide).toHaveBeenCalledTimes(2);
	});

	it('catches up and extends the requested range after returning from the background', async () => {
		const summary = useUpcomingScheduleGuide(() => true);
		lifecycle.mounted.forEach((mount) => mount());
		await summary.load();
		document.visibilityState = 'hidden';
		vi.setSystemTime(new Date('2026-09-05T19:00:00Z'));
		document.visibilityState = 'visible';
		document.dispatchEvent(new Event('visibilitychange'));
		await summary.load();
		expect(store.loadGuide).toHaveBeenLastCalledWith('2026-09-05', 2);
		expect(summary.window.value.start).toBe(Date.now());
	});

	it('retries a transport failure on the next clock tick and cleans up on unmount', async () => {
		store.loadGuide.mockRejectedValueOnce(new TypeError('offline'));
		const summary = useUpcomingScheduleGuide(() => true);
		lifecycle.mounted.forEach((mount) => mount());
		await summary.load();
		expect(summary.status.value).toBe('failed');
		await vi.advanceTimersByTimeAsync(SCHEDULE_SUMMARY_REFRESH_MS);
		expect(store.loadGuide).toHaveBeenCalledTimes(2);
		document.dispatchEvent(new Event('visibilitychange'));
		await summary.load();
		expect(summary.status.value).toBe('ready');
		lifecycle.unmounted.splice(0).forEach((unmount) => unmount());
		expect(vi.getTimerCount()).toBe(0);
	});
});


it('exhausts two retries, then allows an explicit retry', async () => {
	store.loadGuide.mockRejectedValue(new TypeError('offline'));
	const summary = useUpcomingScheduleGuide(() => true);
	lifecycle.mounted.forEach(mount => mount());
	await summary.load();
	await vi.advanceTimersByTimeAsync(SCHEDULE_SUMMARY_REFRESH_MS * 5);
	expect(store.loadGuide).toHaveBeenCalledTimes(3);
	expect(summary.recovering.value).toBe(false);
	await summary.load(true);
	expect(store.loadGuide).toHaveBeenCalledTimes(4);
	expect(summary.recovering.value).toBe(true);
});

it('does not automatically retry a validation failure and keeps covered cached summaries', async () => {
	store.guide = guide('2026-09-03', 3);
	store.loadGuide.mockRejectedValue(new Error('Validation failed'));
	const summary = useUpcomingScheduleGuide(() => true);
	lifecycle.mounted.forEach(mount => mount());
	await summary.load(true);
	expect(summary.status.value).toBe('stale');
	await vi.advanceTimersByTimeAsync(SCHEDULE_SUMMARY_REFRESH_MS * 3);
	expect(store.loadGuide).toHaveBeenCalledTimes(1);
	expect(summary.recovering.value).toBe(false);
	document.dispatchEvent(new Event('visibilitychange'));
	await summary.load();
	expect(store.loadGuide).toHaveBeenCalledTimes(1);
});
