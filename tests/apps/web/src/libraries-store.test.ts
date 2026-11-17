import { createPinia, setActivePinia } from 'pinia';
import { afterEach, expect, it, vi } from 'vitest';
import type { Library } from '@moirai/shared';
import { api } from '@web/api.js';
import { useLibrariesStore } from '@web/stores/libraries.js';

afterEach(() => vi.restoreAllMocks());

function deferredLibraries() {
	let resolve!: (libraries: Library[]) => void;
	const promise = new Promise<Library[]>(complete => {
		resolve = complete;
	});
	return { resolve, promise };
}

it.each(['older', 'latest'] as const)('waits for the authoritative library response when the %s read completes first', async first => {
	setActivePinia(createPinia());
	const older = deferredLibraries();
	const latest = deferredLibraries();
	vi.spyOn(api, 'libraries').mockReturnValueOnce(older.promise).mockReturnValueOnce(latest.promise);
	const store = useLibrariesStore();
	const shell = store.load();
	const page = vi.fn();
	const bootstrap = store.ensureLoaded().then(page);
	const refresh = store.load();

	if (first === 'older') {
		older.resolve([]);
		await older.promise;
		await Promise.resolve();
		expect(store.loading).toBe(true);
		expect(page).not.toHaveBeenCalled();
	}

	latest.resolve([]);
	await expect(bootstrap).resolves.toBeUndefined();
	expect(store.loaded).toBe(true);
	expect(store.loading).toBe(false);
	older.resolve([]);
	await Promise.all([shell, refresh]);
});
