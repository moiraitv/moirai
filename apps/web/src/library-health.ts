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

/** Identify a scan that started after the library's most recent completion. */
export function isLibraryScanning(library: Library): boolean {
	return Boolean(library.lastScanStartedAt
		&& (!library.lastScanCompletedAt || library.lastScanStartedAt > library.lastScanCompletedAt));
}

/** Summarize scan activity from the shared library collection without per-library requests. */
export function libraryScanStatus(library: Library): string {
	if (isLibraryScanning(library)) {
		return 'Scanning';
	}
	if (isLibrarySourceUnavailable(library)) {
		return 'Offline';
	}
	if (library.warningCount > 0) {
		return 'Warnings';
	}
	return library.lastScanCompletedAt ? 'Idle' : 'Not scanned';
}
