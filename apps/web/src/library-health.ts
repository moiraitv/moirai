import type { Library } from '@moirai/shared';

/** Identify an enabled on-disk library whose configured source cannot be reached. */
export function isLibrarySourceUnavailable(library: Library): boolean {
	return (
		library.enabled
		&& library.sourceType === 'on-disk'
		&& library.sourceAvailability === 'unavailable'
	);
}

/** Choose the concise library-list status without hiding an active scan. */
export function libraryStatusValue(library: Library, scanning: boolean): string {
	if (scanning) {
		return 'running';
	}

	return isLibrarySourceUnavailable(library) ? 'offline' : library.watcherStatus;
}
