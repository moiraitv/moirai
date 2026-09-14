import { afterEach, expect, it, vi } from 'vitest';
import { useGuideDateRefresh } from '@web/composables/useGuideDateRefresh.js';

const lifecycle = vi.hoisted(() => ({ mount: () => {}, unmount: () => {} }));
vi.mock('vue', () => ({
	onMounted: (callback: () => void) => {
		lifecycle.mount = callback; 
	},
	onBeforeUnmount: (callback: () => void) => {
		lifecycle.unmount = callback; 
	},
}));

afterEach(() => {
	lifecycle.unmount();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

it('checks dates without same-day requests, refreshes after resume, and retries failures', async () => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date('2026-09-14T06:58:00Z'));
	const document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
	vi.stubGlobal('document', document);
	const refresh = vi.fn().mockResolvedValue(undefined);
	const onError = vi.fn();
	useGuideDateRefresh({ timeZone: 'America/Los_Angeles', guideLoaded: true, capabilitiesLoaded: true }, refresh, onError);
	lifecycle.mount();
	await vi.advanceTimersByTimeAsync(60_000);
	expect(refresh).not.toHaveBeenCalled();
	await vi.advanceTimersByTimeAsync(60_000);
	expect(refresh).toHaveBeenCalledTimes(1);
	await vi.advanceTimersByTimeAsync(60_000);
	expect(refresh).toHaveBeenCalledTimes(1);

	document.visibilityState = 'hidden';
	vi.setSystemTime(new Date('2026-09-16T12:00:00Z'));
	await vi.advanceTimersByTimeAsync(60_000);
	expect(refresh).toHaveBeenCalledTimes(1);
	refresh.mockRejectedValueOnce(new Error('Offline'));
	document.visibilityState = 'visible';
	document.dispatchEvent(new Event('visibilitychange'));
	await vi.advanceTimersByTimeAsync(0);
	expect(onError).toHaveBeenCalledTimes(1);
	await vi.advanceTimersByTimeAsync(60_000);
	expect(refresh).toHaveBeenCalledTimes(3);
	lifecycle.unmount();
	vi.setSystemTime(new Date('2026-09-17T12:00:00Z'));
	document.dispatchEvent(new Event('visibilitychange'));
	await vi.advanceTimersByTimeAsync(60_000);
	expect(refresh).toHaveBeenCalledTimes(3);
});
