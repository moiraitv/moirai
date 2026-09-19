import { ref } from 'vue';
import { defineStore } from 'pinia';
import type { Library, LiveEvent } from '@moirai/shared';
import { api } from '../api';
import { errorMessage } from '../error-message';

/** Shared library collection used by navigation and pages that show the complete index. */
export const useLibrariesStore = defineStore('libraries', () => {
	const libraries = ref<Library[]>([]);
	const loading = ref(true);
	const loaded = ref(false);
	const error = ref('');
	let loadSequence = 0;
	let refreshTimer: number | undefined;

	/** Load libraries while ignoring responses superseded by a newer request. */
	async function load(): Promise<void> {
		const sequence = ++loadSequence;
		if (!loaded.value) {
			loading.value = true;
		}
		try {
			const result = await api.libraries();
			if (sequence !== loadSequence) {
				return;
			}

			libraries.value = result;
			loaded.value = true;
			error.value = '';
		}
		catch (cause) {
			if (sequence !== loadSequence) {
				return;
			}

			error.value = errorMessage(cause);
		}
		finally {
			if (sequence === loadSequence) {
				loading.value = false;
			}
		}
	}

	/** Apply scan activity immediately without fetching the collection for each progress event. */
	function applyScanEvent(data: Extract<LiveEvent, { type: 'scan.changed' }>['data']): void {
		const library = libraries.value.find((entry) => entry.id === data.libraryId);
		if (!library) {
			return;
		}
		library.lastScanStartedAt = data.startedAt;
		if (data.completedAt) {
			library.lastScanCompletedAt = data.completedAt;
			library.warningCount = data.issueCount;
		}
	}

	/** Queue refresh without duplicating pending work in the shared UI store. */
	function scheduleRefresh(): void {
		window.clearTimeout(refreshTimer);
		refreshTimer = window.setTimeout(() => void load(), 100);
	}

	return { libraries, loading, loaded, error, load, scheduleRefresh, applyScanEvent };
});
