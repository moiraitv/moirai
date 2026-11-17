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
	const configuration = ref<SchedulingOverview | null>(null);
	const configurationError = ref('');
	let configurationSequence = 0;

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

	/** Read authored scheduling data for views that need assignments and names only. */
	async function loadConfiguration(): Promise<void> {
		const sequence = ++configurationSequence;
		configurationError.value = '';
		try {
			const result = await api.schedulingConfiguration();
			if (sequence === configurationSequence) {
				configuration.value = result;
			}
		}
		catch (cause) {
			if (sequence === configurationSequence) {
				configurationError.value = errorMessage(cause);
			}
		}
	}

	return { overview, loading, loaded, error, load, configuration, configurationError, loadConfiguration };
});
