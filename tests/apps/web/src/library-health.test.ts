import { describe, expect, it } from 'vitest';
import { libraryCreateSchema, type Library } from '@moirai/shared';
import { isLibrarySourceUnavailable, libraryStatusValue } from '@web/library-health';

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
