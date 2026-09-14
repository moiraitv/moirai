import { createPinia, setActivePinia } from 'pinia';
import { afterEach, expect, it, vi } from 'vitest';
import { api } from '@web/api';
import { useLogsStore } from '@web/stores/logs';

afterEach(() => vi.restoreAllMocks());

it('ignores a superseded log request failure while propagating the current failure', async () => {
	setActivePinia(createPinia());
	let reject!: (cause: Error) => void;
	const request = vi.spyOn(api, 'logs').mockImplementationOnce(() => new Promise((_, fail) => {
		reject = fail;
	}));
	request.mockResolvedValue({ entries: [], nextCursor: null, scanLimitReached: false, scannedBytes: 0 });
	vi.spyOn(api, 'logFiles').mockResolvedValue([]);
	const store = useLogsStore();
	const previous = store.load('', 'old');
	await store.load('', 'new');
	reject(new TypeError('Obsolete failure'));
	await expect(previous).resolves.toBeUndefined();
	expect(store.error).toBe('');
	expect(store.activeSearch).toBe('new');
	request.mockRejectedValue(new TypeError('Current failure'));
	await expect(store.load()).rejects.toThrow('Current failure');
});

it('discards a paging failure after changing log filters', async () => {
	setActivePinia(createPinia());
	const request = vi.spyOn(api, 'logs').mockResolvedValue({ entries: [], nextCursor: 'older', scanLimitReached: false, scannedBytes: 0 });
	vi.spyOn(api, 'logFiles').mockResolvedValue([]);
	const store = useLogsStore();
	await store.load();
	let reject!: (cause: Error) => void;
	request.mockImplementationOnce(() => new Promise((_, fail) => {
		reject = fail;
	}));
	const paging = store.loadMore();
	await store.load('', 'new filter');
	reject(new TypeError('Old page failed'));
	await paging;
	expect(store.error).toBe('');
	expect(store.activeSearch).toBe('new filter');
});
