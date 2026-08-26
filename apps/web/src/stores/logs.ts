import { ref } from 'vue';
import { defineStore } from 'pinia';
import type { LogEntry, LogFile, LogLevel } from '@moirai/shared';
import { api } from '../api';
import { errorMessage } from '../error-message';

/** Preserve the most recently loaded log page across route navigation. */
export const useLogsStore = defineStore('logs', () => {
	// Retain loaded rows, filters, and pagination while the Logs route is inactive.
	const entries = ref<LogEntry[]>([]);
	const files = ref<LogFile[]>([]);
	const loading = ref(false);
	const loaded = ref(false);
	const loadingMore = ref(false);
	const error = ref('');
	const nextCursor = ref<string | null>(null);
	const scanLimitReached = ref(false);
	const activeLevel = ref<LogLevel | ''>('');
	const activeSearch = ref('');
	let sequence = 0;

	/** Load filtered log entries while ignoring superseded responses. */
	async function load(level = activeLevel.value, search = activeSearch.value): Promise<void> {
		const current = ++sequence;
		loading.value = true;
		try {
			const [page, retainedFiles] = await Promise.all([
				api.logs({ level: level || undefined, search: search || undefined, limit: 100 }),
				api.logFiles(),
			]);
			if (current !== sequence) {
				return;
			}

			entries.value = page.entries;
			files.value = retainedFiles;
			nextCursor.value = page.nextCursor;
			scanLimitReached.value = page.scanLimitReached;
			activeLevel.value = level;
			activeSearch.value = search;
			loaded.value = true;
			error.value = '';
		}
		catch (cause) {
			if (current === sequence) {
				error.value = errorMessage(cause);
			}
			throw cause;
		}
		finally {
			if (current === sequence) {
				loading.value = false;
			}
		}
	}

	/** Load more from the authoritative source and update the shared UI store. */
	async function loadMore(): Promise<void> {
		if (!nextCursor.value || loadingMore.value) {
			return;
		}

		loadingMore.value = true;
		try {
			const page = await api.logs({
				cursor: nextCursor.value,
				level: activeLevel.value || undefined,
				search: activeSearch.value || undefined,
				limit: 100,
			});
			entries.value.push(...page.entries);
			nextCursor.value = page.nextCursor;
			scanLimitReached.value = page.scanLimitReached;
			error.value = '';
		}
		catch (cause) {
			error.value = errorMessage(cause);
		}
		finally {
			loadingMore.value = false;
		}
	}

	// Expose cached state and paging actions to the Logs view.
	return {
		entries,
		files,
		loading,
		loaded,
		loadingMore,
		error,
		nextCursor,
		scanLimitReached,
		activeLevel,
		activeSearch,
		load,
		loadMore,
	};
});
