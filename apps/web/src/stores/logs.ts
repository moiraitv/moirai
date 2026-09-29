import { ref } from 'vue';
import { defineStore } from 'pinia';
import type { LogEntry, LogFile, LogLevel } from '@moirai/shared';
import { api } from '../api';
import { errorMessage } from '../error-message';

/** Preserve loaded log history and pagination across refreshes and route navigation. */
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
	let loadSequence = 0;
	let filterSequence = 0;

	/** Refresh current logs without dropping loaded history; replace it when filters change. */
	async function load(level = activeLevel.value, search = activeSearch.value): Promise<void> {
		const sameFilter = loaded.value && level === activeLevel.value && search === activeSearch.value;
		const current = ++loadSequence;
		if (!sameFilter) {
			filterSequence += 1;
		}
		loading.value = true;
		try {
			const [page, retainedFiles] = await Promise.all([
				api.logs({ level: level || undefined, search: search || undefined, limit: 100 }),
				api.logFiles(),
			]);
			if (current !== loadSequence) {
				return;
			}

			if (sameFilter) {
				const seen = new Set(page.entries.map(entry => entry.id));
				entries.value = [...page.entries, ...entries.value.filter(entry => !seen.has(entry.id))];
			}
			else {
				entries.value = page.entries;
				nextCursor.value = page.nextCursor;
				scanLimitReached.value = page.scanLimitReached;
			}
			files.value = retainedFiles;
			activeLevel.value = level;
			activeSearch.value = search;
			loaded.value = true;
			error.value = '';
		}
		catch (cause) {
			if (current !== loadSequence) {
				return;
			}
			error.value = errorMessage(cause);
			throw cause;
		}
		finally {
			if (current === loadSequence) {
				loading.value = false;
			}
		}
	}

	/** Load more from the authoritative source and update the shared UI store. */
	async function loadMore(): Promise<void> {
		if (!nextCursor.value || loadingMore.value) {
			return;
		}

		const current = filterSequence;
		loadingMore.value = true;
		try {
			const page = await api.logs({
				cursor: nextCursor.value,
				level: activeLevel.value || undefined,
				search: activeSearch.value || undefined,
				limit: 100,
			});
			if (current !== filterSequence) {
				return;
			}
			const seen = new Set(entries.value.map(entry => entry.id));
			entries.value.push(...page.entries.filter(entry => !seen.has(entry.id)));
			nextCursor.value = page.nextCursor;
			scanLimitReached.value = page.scanLimitReached;
			error.value = '';
		}
		catch (cause) {
			if (current === filterSequence) {
				error.value = errorMessage(cause);
			}
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
