import { createPinia, setActivePinia } from 'pinia';
import { useLibrariesStore } from '@web/stores/libraries';
import { api } from '@web/api';
import { describe, expect, it, vi } from 'vitest';
import { libraryCreateSchema, type Library } from '@moirai/shared';
import { isLibrarySourceUnavailable, libraryStatusValue, libraryScanStatus } from '@web/library-health';

/** Build one library status fixture from public contract defaults. */
function library(sourceAvailability: Library['sourceAvailability']): Library {
	return {
		...libraryCreateSchema.parse({
			name: 'Movies',
			typeKey: 'movies',
			sourceType: 'on-disk',
			sourceConfig: { scanRoot: '/media/movies', playbackRoot: null },
		}),
		id: crypto.randomUUID(),
		watcherStatus: sourceAvailability === 'unavailable' ? 'error' : 'ready',
		sourceAvailability,
		sourceAvailabilityUpdatedAt: null,
		reconciliationStatus: 'idle',
		pendingRemovalCount: 0,
		lastScanStartedAt: null,
		lastScanCompletedAt: null,
		lastChangeDetectedAt: null,
		lastIndexedChangeAt: null,
		itemCount: 12,
		warningCount: 0,
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	};
}

describe('library source health presentation', () => {
	it('identifies unavailable enabled on-disk sources as offline', () => {
		const unavailable = library('unavailable');
		expect(isLibrarySourceUnavailable(unavailable)).toBe(true);
		expect(libraryStatusValue(unavailable, false)).toBe('offline');
	});

	it('keeps active scans and healthy watcher states distinct', () => {
		const available = library('available');
		expect(isLibrarySourceUnavailable(available)).toBe(false);
		expect(libraryStatusValue(available, false)).toBe('ready');
		expect(libraryStatusValue(available, true)).toBe('running');
	});
});

it('reports initial, running, idle, warning, and offline scan states', () => {
	const entry = library('available');
	expect(libraryScanStatus(entry)).toBe('Not scanned');
	entry.lastScanStartedAt = '2026-09-19T10:00:00Z';
	expect(libraryScanStatus(entry)).toBe('Scanning');
	entry.lastScanCompletedAt = '2026-09-19T10:01:00Z';
	expect(libraryScanStatus(entry)).toBe('Idle');
	entry.warningCount = 1;
	expect(libraryScanStatus(entry)).toBe('Warnings');
	entry.sourceAvailability = 'unavailable';
	expect(libraryScanStatus(entry)).toBe('Offline');
	entry.lastScanStartedAt = '2026-09-19T10:02:00Z';
	expect(libraryScanStatus(entry)).toBe('Scanning');
});

it('updates shared scan status from live events without fetching on progress', () => {
	setActivePinia(createPinia());
	const store = useLibrariesStore();
	const entry = library('available');
	store.libraries = [entry];
	const request = vi.spyOn(api, 'libraries');
	const event = {
		libraryId: entry.id, scanId: crypto.randomUUID(), trigger: 'manual' as const,
		status: 'running' as const, startedAt: '2026-09-19T10:00:00Z', completedAt: null,
		discoveredCount: 0, changedCount: 0, removedCount: 0, issueCount: 0,
		affectsProgramming: false,
	};
	try {
		store.applyScanEvent(event);
		expect(libraryScanStatus(store.libraries[0]!)).toBe('Scanning');
		store.applyScanEvent({ ...event, discoveredCount: 5 });
		store.applyScanEvent({ ...event, status: 'complete', completedAt: '2026-09-19T10:01:00Z' });
		expect(libraryScanStatus(store.libraries[0]!)).toBe('Idle');
		expect(request).not.toHaveBeenCalled();
	}
	finally {
		request.mockRestore();
	}
});
