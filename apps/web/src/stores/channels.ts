import { ref } from 'vue';
import { defineStore } from 'pinia';
import {
	DEFAULT_MAX_EXPLICIT_MEDIA_ITEMS,
	type Channel,
	type ScheduleGuide,
} from '@moirai/shared';
import { api } from '../api';
import { shiftDateKey } from '../date-key';
import { errorMessage } from '../error-message';

/** History effect applied after one successful guide request. */
type GuideNavigation = 'preserve' | 'forward' | 'backward';

/** Cached channel and guide state shared by channel consumers across route changes. */
export const useChannelsStore = defineStore('channels', () => {
	// Preserve the most recent successful data while route components remount.
	const channels = ref<Channel[]>([]);
	const loading = ref(true);
	const loaded = ref(false);
	const timeZone = ref('UTC');
	const publicUrl = ref('');
	const publicUrlStatus = ref<'configured' | 'unreachable-default'>('configured');
	const maxExplicitMediaItems = ref(DEFAULT_MAX_EXPLICIT_MEDIA_ITEMS);
	const capabilitiesLoaded = ref(false);
	const guide = ref<ScheduleGuide | null>(null);
	const guideWeekStart = ref('');
	const guideDays = ref(0);
	const guideLoading = ref(false);
	const guideLoaded = ref(false);
	const guideStartHistory = ref<string[]>([]);
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
			maxExplicitMediaItems.value = result.maxExplicitMediaItems;
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
	async function loadGuide(
		startDate: string,
		days = 7,
		navigation: GuideNavigation = 'preserve',
	): Promise<void> {
		const sequence = ++guideSequence;
		const previousStart = guideWeekStart.value;
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
			if (navigation === 'forward' && previousStart && previousStart !== startDate) {
				if (guideStartHistory.value.at(-1) !== previousStart) {
					guideStartHistory.value.push(previousStart);
				}
			}
			else if (
				navigation === 'backward'
				&& guideStartHistory.value.at(-1) === startDate
			) {
				guideStartHistory.value.pop();
			}
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

	/** Return the next valid guide boundary without mutating navigation history. */
	function guideNavigationTarget(direction: 'forward' | 'backward'): string | null {
		if (!guideWeekStart.value || !guide.value) {
			return null;
		}

		if (direction === 'forward') {
			const target = shiftDateKey(guideWeekStart.value, guide.value.days);
			return guide.value.committedEndDate && target >= guide.value.committedEndDate
				? null
				: target;
		}

		const committedStart = guide.value.committedStartDate;
		if (committedStart && guideWeekStart.value <= committedStart) {
			return null;
		}

		const remembered = guideStartHistory.value.at(-1);
		if (remembered) {
			return remembered;
		}

		const fallback = shiftDateKey(guideWeekStart.value, -guide.value.days);
		return committedStart && fallback < committedStart ? committedStart : fallback;
	}

	/** Discard prior guide boundaries after an explicit navigation reset. */
	function clearGuideNavigationHistory(): void {
		guideStartHistory.value = [];
	}

	// Expose stable refs and refresh actions to every channel and guide view.
	return {
		channels,
		loading,
		loaded,
		timeZone,
		publicUrl,
		publicUrlStatus,
		maxExplicitMediaItems,
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
		guideNavigationTarget,
		clearGuideNavigationHistory,
	};
});
