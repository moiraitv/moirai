import { ref } from 'vue';
import { defineStore } from 'pinia';
import type { DataConflictReport, PlaybackEngineStatus } from '@moirai/shared';
import { api } from '../api';
import { errorMessage } from '../error-message';

/** Cached dashboard-only status so route changes can render the prior summary immediately. */
export const useDashboardStore = defineStore('dashboard', () => {
	const playback = ref<PlaybackEngineStatus | null>(null);
	const conflictReport = ref<DataConflictReport | null>(null);
	const loading = ref(true);
	const loaded = ref(false);
	const error = ref('');
	let loadSequence = 0;

	/** Load dashboard data while ignoring responses superseded by a newer request. */
	async function load(): Promise<void> {
		const sequence = ++loadSequence;
		if (!loaded.value) {
			loading.value = true;
		}
		try {
			const [result, conflicts] = await Promise.all([
				api.playbackStatus(),
				api.dataConflicts(),
			]);
			if (sequence !== loadSequence) {
				return;
			}

			playback.value = result;
			conflictReport.value = conflicts;
			loaded.value = true;
			error.value = '';
		}
		catch (cause) {
			if (sequence === loadSequence) {
				error.value = errorMessage(cause);
			}
		}
		finally {
			if (sequence === loadSequence) {
				loading.value = false;
			}
		}
	}

	return { playback, conflictReport, loading, loaded, error, load };
});
