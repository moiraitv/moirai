import { computed, ref, shallowRef } from 'vue';
import { defineStore } from 'pinia';
import {
	DEFAULT_MAX_EXPLICIT_MEDIA_ITEMS,
	XMLTV_EPG_DAYS,
	type Channel,
	type ChannelTimelineMaterializationStatus,
	type ScheduleGuide,
} from '@moirai/shared';
import { api } from '../api';
import { calendarDateSpan, dateKey, shiftDateKey } from '../date-key';
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
	const guideHorizonDays = ref(XMLTV_EPG_DAYS);
	const publicUrl = ref('');
	const publicUrlStatus = ref<'configured' | 'unreachable-default'>('configured');
	const maxExplicitMediaItems = ref(DEFAULT_MAX_EXPLICIT_MEDIA_ITEMS);
	const capabilitiesLoaded = ref(false);
	const guide = shallowRef<ScheduleGuide | null>(null);
	const guideWeekStart = ref('');
	const guideDays = ref(0);
	const guideLoading = ref(false);
	const guideRefreshing = ref(false);
	const guideError = ref('');
	const materializations = shallowRef<ChannelTimelineMaterializationStatus[]>([]);
	const materializationsLoaded = ref(false);
	const guideRowStates = computed(() => {
		const statuses = new Map(materializations.value.map(status => [status.channelId, status]));
		return Object.fromEntries(channels.value.map(channel => {
			const status = statuses.get(channel.id);
			const state = status?.health === 'failed' ? 'failed'
				: !materializationsLoaded.value ? 'loading'
					: status ? 'preparing' : guideRefreshing.value ? 'loading' : 'unassigned';
			return [channel.id, { state: guideError.value && state !== 'unassigned' ? 'failed' : state,
				message: status?.lastError ?? guideError.value }];
		}));
	});
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

	let pendingChannels: Promise<void> | undefined;

	/** Share concurrent channel refreshes without delaying saves on redundant reads. */
	function loadChannels(force = false): Promise<void> {
		if (pendingChannels && !force) {
			return pendingChannels;
		}
		const promise = performChannelLoad().finally(() => {
			if (pendingChannels === promise) {
				pendingChannels = undefined;
			}
		});
		pendingChannels = promise;
		return promise;
	}

	/** Load channels from the authoritative source and update the shared UI store. */
	async function performChannelLoad(): Promise<void> {
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

	let capabilitiesStale = false;

	/** Require fresh runtime settings before the next guide read after a server reconnect. */
	function invalidateCapabilities(): void {
		capabilitiesStale = true;
		capabilitySequence += 1;
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
			guideHorizonDays.value = result.guideDays ?? XMLTV_EPG_DAYS;
			publicUrl.value = result.publicUrl;
			publicUrlStatus.value = result.publicUrlStatus;
			maxExplicitMediaItems.value = result.maxExplicitMediaItems;
			capabilitiesLoaded.value = true;
			capabilitiesStale = false;
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
		const sequence = ++guideSequence;
		guideRefreshing.value = true;
		guideError.value = '';
		const previousStart = guideWeekStart.value;
		if (!guideLoaded.value || guideWeekStart.value !== startDate) {
			guideLoading.value = true;
		}
		try {
			if (capabilitiesStale) {
				await loadCapabilities();
				if (sequence !== guideSequence) {
					return;
				}
			}
			const today = dateKey(new Date(), timeZone.value);
			if (startDate < today) {
				startDate = today;
				days = 7;
				navigation = 'preserve';
			}
			const endDate = shiftDateKey(today, guideHorizonDays.value);
			if (startDate >= endDate) {
				startDate = today;
				navigation = 'preserve';
			}
			days = Math.max(1, Math.min(days, calendarDateSpan(startDate, endDate)));

			const statuses = api.timelineMaterializations().then(result => {
				if (sequence === guideSequence) {
					materializations.value = result;
					materializationsLoaded.value = true;
				}
			});
			// Observe failures immediately while the guide and status reads run together.
			void statuses.catch(() => undefined);
			if (days > 1 && (guideWeekStart.value !== startDate || guideDays.value < 1)) {
				const [first] = await Promise.all([api.scheduleGuide(startDate, 1), statuses]);
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

			const [result] = await Promise.all([api.scheduleGuide(startDate, days), statuses]);
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
			guideError.value = errorMessage(cause);
			error.value = guideError.value;
			throw cause;
		}
		finally {
			if (sequence === guideSequence) {
				guideLoading.value = false;
				guideRefreshing.value = false;
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
			const configuredEnd = shiftDateKey(dateKey(new Date(), timeZone.value), guideHorizonDays.value);
			const committedEnd = guide.value.committedEndDate && guide.value.committedEndDate < configuredEnd
				? guide.value.committedEndDate : configuredEnd;
			return target >= committedEnd
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
		guideHorizonDays,
		publicUrl,
		publicUrlStatus,
		maxExplicitMediaItems,
		capabilitiesLoaded,
		guide,
		guideWeekStart,
		guideDays,
		guideLoading,
		guideLoaded,
		guideRefreshing,
		guideError,
		guideRowStates,
		error,
		loadChannels,
		acceptSavedChannel,
		loadCapabilities,
		invalidateCapabilities,
		loadGuide,
		guideNavigationTarget,
		clearGuideNavigationHistory,
	};
});
