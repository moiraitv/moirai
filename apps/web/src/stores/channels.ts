import { ref } from 'vue';
import { defineStore } from 'pinia';
import type { Channel, ScheduleGuide } from '@moirai/shared';
import { api } from '../api';
import { errorMessage } from '../error-message';

/** Cached channel and guide state shared by channel consumers across route changes. */
export const useChannelsStore = defineStore('channels', () => {
	// Preserve the most recent successful data while route components remount.
	const channels = ref<Channel[]>([]);
	const loading = ref(true);
	const loaded = ref(false);
	const timeZone = ref('UTC');
	const publicUrl = ref('');
	const publicUrlStatus = ref<'configured' | 'unreachable-default'>('configured');
	const capabilitiesLoaded = ref(false);
	const guide = ref<ScheduleGuide | null>(null);
	const guideWeekStart = ref('');
	const guideDays = ref(0);
	const guideLoading = ref(false);
	const guideLoaded = ref(false);
	const error = ref('');

	// Ignore responses superseded by a newer request in the same data domain.
	let channelSequence = 0;
	let capabilitySequence = 0;
	let guideSequence = 0;

	/** Load channels from the authoritative source and update the shared UI store. */
	async function loadChannels(): Promise<void> {
		const sequence = ++channelSequence;
		if (!loaded.value) {
			loading.value = true;
		}
		try {
			const result = await api.channels();
			if (sequence !== channelSequence) {
				return;
			}

			channels.value = result;
			loaded.value = true;
			error.value = '';
		}
		catch (cause) {
			if (sequence === channelSequence) {
				error.value = errorMessage(cause);
			}
			throw cause;
		}
		finally {
			if (sequence === channelSequence) {
				loading.value = false;
			}
		}
	}

	/** Load capabilities from the authoritative source and update the shared UI store. */
	async function loadCapabilities(): Promise<void> {
		const sequence = ++capabilitySequence;
		try {
			const result = await api.capabilities();
			if (sequence !== capabilitySequence) {
				return;
			}

			timeZone.value = result.timeZone;
			publicUrl.value = result.publicUrl;
			publicUrlStatus.value = result.publicUrlStatus;
			capabilitiesLoaded.value = true;
			error.value = '';
		}
		catch (cause) {
			if (sequence === capabilitySequence) {
				error.value = errorMessage(cause);
			}
			throw cause;
		}
	}

	/** Load guide from the authoritative source and update the shared UI store. */
	async function loadGuide(startDate: string, days = 7): Promise<void> {
		const sequence = ++guideSequence;
		if (
			!guideLoaded.value
			|| guideWeekStart.value !== startDate
			|| guideDays.value !== days
		) {
			guideLoading.value = true;
		}
		try {
			const result = await api.scheduleGuide(startDate, days);
			if (sequence !== guideSequence) {
				return;
			}

			guide.value = result;
			guideWeekStart.value = startDate;
			guideDays.value = days;
			guideLoaded.value = true;
			error.value = '';
		}
		catch (cause) {
			if (sequence === guideSequence) {
				error.value = errorMessage(cause);
			}
			throw cause;
		}
		finally {
			if (sequence === guideSequence) {
				guideLoading.value = false;
			}
		}
	}

	// Expose stable refs and refresh actions to every channel and guide view.
	return {
		channels,
		loading,
		loaded,
		timeZone,
		publicUrl,
		publicUrlStatus,
		capabilitiesLoaded,
		guide,
		guideWeekStart,
		guideDays,
		guideLoading,
		guideLoaded,
		error,
		loadChannels,
		loadCapabilities,
		loadGuide,
	};
});
