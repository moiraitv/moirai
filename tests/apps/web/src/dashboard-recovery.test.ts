import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { PlaybackEngineStatus, DataConflictReport } from '@moirai/shared';
import { api, ApiError } from '@web/api';
import { useDashboardStore, PLAYBACK_FAILURE_LIMIT } from '@web/stores/dashboard';

beforeEach(() => setActivePinia(createPinia()));
afterEach(() => vi.restoreAllMocks());

it('retains playback through transient failures and clears only playback recovery on success', async () => {
	const status = { sessions: [] } as unknown as PlaybackEngineStatus;
	const request = vi.spyOn(api, 'playbackStatus').mockResolvedValue(status);
	vi.spyOn(api, 'dataConflicts').mockRejectedValue(new Error('Conflict report failed'));
	const store = useDashboardStore();
	await store.load();
	expect(store.error).toBe('Conflict report failed');
	const updated = store.playbackUpdatedAt;
	request.mockRejectedValue(new TypeError('Offline'));
	for (let count = 1; count <= PLAYBACK_FAILURE_LIMIT; count++) {
		await store.refreshPlayback();
		expect(store.playbackRecovering).toBe(count < PLAYBACK_FAILURE_LIMIT);
		expect(store.playback).toEqual(status);
		expect(store.playbackUpdatedAt).toBe(updated);
	}
	request.mockResolvedValue(status);
	await store.refreshPlayback();
	expect(store.playbackError).toBe('');
	expect(store.error).toBe('Conflict report failed');
	request.mockRejectedValue(new ApiError({ message: 'Sign in', code: 'unauthorized', requestId: 'test' }, 401));
	await store.refreshPlayback();
	expect(store.playbackRecovering).toBe(false);
	expect(store.playbackError).toBe('Sign in');
});

it('coalesces concurrent reads and exposes initial failure without pretending cached data exists', async () => {
	let reject!: (cause: Error) => void;
	const request = vi.spyOn(api, 'playbackStatus').mockImplementation(() => new Promise((_, fail) => {
		reject = fail; 
	}));
	vi.spyOn(api, 'dataConflicts').mockResolvedValue({} as DataConflictReport);
	const store = useDashboardStore();
	const load = store.load();
	const refresh = store.refreshPlayback();
	expect(request).toHaveBeenCalledTimes(1);
	reject(new TypeError('Offline'));
	await Promise.all([load, refresh]);
	expect(store.loaded).toBe(false);
	expect(store.playbackRecovering).toBe(false);
	expect(store.playbackError).toBe('Offline');
});
