import { createPinia, setActivePinia } from 'pinia';
import { afterEach, expect, it, vi } from 'vitest';
import type { LogEntry, LogPage } from '@moirai/shared';
import { api } from '@web/api';
import { useLogsStore } from '@web/stores/logs';

afterEach(() => vi.restoreAllMocks());

const entry = (id: string): LogEntry => ({ id, time: '2026-09-29T00:00:00.000Z', level: 'info',
	message: id, requestId: null, context: {} });
const page = (ids: string[], nextCursor: string | null): LogPage => ({
	entries: ids.map(entry), nextCursor, scanLimitReached: false, scannedBytes: 0,
});

it('keeps older pages when new entries arrive and resets them only for new filters', async () => {
	setActivePinia(createPinia());
	const request = vi.spyOn(api, 'logs')
		.mockResolvedValueOnce(page(['recent', 'earlier'], 'older'))
		.mockResolvedValueOnce(page(['oldest'], null))
		.mockResolvedValueOnce(page(['new', 'recent'], 'refresh-older'))
		.mockResolvedValueOnce(page(['filtered'], null));
	vi.spyOn(api, 'logFiles').mockResolvedValue([]);
	const store = useLogsStore();

	await store.load();
	await store.loadMore();
	await store.load();
	expect(store.entries.map(value => value.id)).toEqual(['new', 'recent', 'earlier', 'oldest']);
	expect(store.nextCursor).toBeNull();
	expect(request.mock.calls[2]![0]).toMatchObject({ limit: 100 });
	expect(request.mock.calls[2]![0]).not.toHaveProperty('cursor');

	await store.load('warn');
	expect(store.entries.map(value => value.id)).toEqual(['filtered']);
});

it('keeps an older page that finishes during a refresh with the same filters', async () => {
	setActivePinia(createPinia());
	let finishPaging!: (page: LogPage) => void;
	vi.spyOn(api, 'logs')
		.mockResolvedValueOnce(page(['recent'], 'older'))
		.mockImplementationOnce(() => new Promise(resolve => {
			finishPaging = resolve;
		}))
		.mockResolvedValueOnce(page(['new', 'recent'], 'refresh-older'));
	vi.spyOn(api, 'logFiles').mockResolvedValue([]);
	const store = useLogsStore();

	await store.load();
	const paging = store.loadMore();
	await store.load();
	finishPaging(page(['oldest'], null));
	await paging;
	expect(store.entries.map(value => value.id)).toEqual(['new', 'recent', 'oldest']);
});

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
