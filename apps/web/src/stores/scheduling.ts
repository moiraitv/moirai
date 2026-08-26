import { ref } from 'vue';
import { defineStore } from 'pinia';
import type { SchedulingOverview } from '@moirai/shared';
import { api } from '../api';
import { errorMessage } from '../error-message';

/** Shared authoritative scheduling resources used by editors and channel assignment controls. */
export const useSchedulingStore = defineStore('scheduling', () => {
	const overview = ref<SchedulingOverview | null>(null);
	const loading = ref(true);
	const loaded = ref(false);
	const error = ref('');
	let loadSequence = 0;

	/** Load the scheduling overview while ignoring superseded responses. */
	async function load(): Promise<void> {
		const sequence = ++loadSequence;
		if (!loaded.value) {
			loading.value = true;
		}
		try {
			const result = await api.schedulingOverview();
			if (sequence !== loadSequence) {
				return;
			}

			overview.value = result;
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

	return { overview, loading, loaded, error, load };
});
