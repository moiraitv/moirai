import { ref, shallowRef } from 'vue';
import { defineStore } from 'pinia';
import {
	DEFAULT_MAX_EXPLICIT_MEDIA_ITEMS,
	type Channel,
	type ScheduleGuide,
} from '@moirai/shared';
import { api } from '../api';
import { dateKey, shiftDateKey } from '../date-key';
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
	const guide = shallowRef<ScheduleGuide | null>(null);
	const guideWeekStart = ref('');
	const guideDays = ref(0);
	const guideLoading = ref(false);
	const guideLoaded = ref(false);
	const guideStartHistory = ref<string[]>([]);
	const guidePendingWindowDays = ref<number | null>(null);
	const error = ref('');

	// Ignore responses superseded by a newer request in the same data domain.
	let channelSequence = 0;
	let capabilitySequence = 0;
	let guideSequence = 0;

	/** Apply a server-confirmed save immediately and discard older in-flight catalog responses. */
	function acceptSavedChannel(channel: Channel): void {
		channelSequence += 1;
		const index = channels.value.findIndex(candidate => candidate.id === channel.id);
		if (index === -1) {
			channels.value.push(channel);
		}
		else {
			channels.value[index] = channel;
		}
		loading.value = false;
	}

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
			if (sequence !== channelSequence) {
				return;
			}
			error.value = errorMessage(cause);
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
			if (sequence !== capabilitySequence) {
				return;
			}
			error.value = errorMessage(cause);
			throw cause;
		}
	}

	let pendingGuide: { key: string; promise: Promise<void> } | undefined;

	/** Share a route bootstrap read without coalescing explicit mutations or live refreshes. */
	function loadGuide(
		startDate: string,
		days = 7,
		navigation: GuideNavigation = 'preserve',
		reusePending = false,
	): Promise<void> {
		const today = dateKey(new Date(), timeZone.value);
		if (startDate < today) {
			startDate = today;
			days = 7;
			navigation = 'preserve';
		}
		const key = `${startDate}:${days}:${navigation}`;
		if (reusePending && pendingGuide?.key === key) {
			return pendingGuide.promise;
		}
		const promise = performGuideLoad(startDate, days, navigation).finally(() => {
			if (pendingGuide?.promise === promise) {
				pendingGuide = undefined;
			}
		});
		pendingGuide = { key, promise };
		return promise;
	}

	/** Refresh the guide, advancing expired start dates and navigation history to today. */
	async function performGuideLoad(
		startDate: string,
		days = 7,
		navigation: GuideNavigation = 'preserve',
	): Promise<void> {
		const today = dateKey(new Date(), timeZone.value);
		if (startDate < today) {
			startDate = today;
			days = 7;
			navigation = 'preserve';
		}
		const sequence = ++guideSequence;
		const previousStart = guideWeekStart.value;
		if (!guideLoaded.value || guideWeekStart.value !== startDate) {
			guideLoading.value = true;
		}
		try {
			if (days > 1 && (guideWeekStart.value !== startDate || guideDays.value < 1)) {
				const first = await api.scheduleGuide(startDate, 1);
				if (sequence !== guideSequence) {
					return;
				}

				guideStartHistory.value = guideStartHistory.value.filter(date => date >= today);
				guide.value = first;
				guideWeekStart.value = startDate;
				guideDays.value = first.days;
				guidePendingWindowDays.value = days;
				guideLoaded.value = true;
				guideLoading.value = false;
				error.value = '';
			}

			const result = await api.scheduleGuide(startDate, days);
			if (sequence !== guideSequence) {
				return;
			}

			guideStartHistory.value = guideStartHistory.value.filter(date => date >= today);
			guide.value = result;
			guideWeekStart.value = startDate;
			guideDays.value = days;
			guidePendingWindowDays.value = null;
			guideLoaded.value = true;
			if (navigation === 'forward' && previousStart >= today && previousStart !== startDate) {
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
			if (sequence !== guideSequence) {
				return;
			}
			guidePendingWindowDays.value = null;
			error.value = errorMessage(cause);
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
			const step = guidePendingWindowDays.value ?? guide.value.days;
			const target = shiftDateKey(guideWeekStart.value, step);
			return guide.value.committedEndDate && target >= guide.value.committedEndDate
				? null
				: target;
		}

		const today = dateKey(new Date(), timeZone.value);
		const committedStart = guide.value.committedStartDate && guide.value.committedStartDate > today
			? guide.value.committedStartDate : today;
		if (committedStart && guideWeekStart.value <= committedStart) {
			return null;
		}

		const remembered = guideStartHistory.value.at(-1);
		if (remembered) {
			return remembered;
		}

		const fallback = shiftDateKey(
			guideWeekStart.value,
			-(guidePendingWindowDays.value ?? guide.value.days),
		);
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
		acceptSavedChannel,
		loadCapabilities,
		loadGuide,
		guideNavigationTarget,
		clearGuideNavigationHistory,
	};
});
