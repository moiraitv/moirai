import type { Library, MediaServer } from '@moirai/shared';

/** Identify an enabled library whose configured source cannot be reached. */
export function isLibrarySourceUnavailable(library: Library): boolean {
	return library.enabled && library.sourceAvailability === 'unavailable';
}

/** Choose the concise library-list status without hiding an active scan. */
export function libraryStatusValue(library: Library, scanning: boolean): string {
	if (scanning) {
		return 'running';
	}

	if (isLibrarySourceUnavailable(library)) {
		return 'offline';
	}

	return library.sourceType === 'on-disk' ? library.watcherStatus : 'scheduled';
}

/** Describe where a library reads media, without showing a folder for a remote server. */
export function librarySourceLabel(library: Library, servers: MediaServer[] = []): string {
	const config = library.sourceConfig;
	if ('scanRoot' in config) {
		return config.scanRoot;
	}

	const server = servers.find((entry) => entry.id === config.mediaServerId);
	const serverName = server?.name ?? 'Media server';
	return `${serverName} · ${config.remoteLibraryName}`;
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
