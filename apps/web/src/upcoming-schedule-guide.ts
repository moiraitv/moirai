import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { guideCoversScheduleWindow, upcomingScheduleWindow } from './channel-schedule-preview';
import { errorMessage } from './error-message';
import { useChannelsStore } from './stores/channels';

/** Refresh relative schedule summaries locally without polling the guide endpoint. */
export const SCHEDULE_SUMMARY_REFRESH_MS = 60_000;

/** Distinguish full coverage from pending, failed, or resource-limited guide responses. */
export type UpcomingGuideStatus = 'ready' | 'loading' | 'failed' | 'incomplete' | 'unavailable';

/**
 * Own the channel catalog's rolling clock and bounded guide refreshes. Cached ranges are reused;
 * failed or truncated requests are retried only after invalidation or a change of requested range.
 */
export function useUpcomingScheduleGuide(enabled: () => boolean) {
	const store = useChannelsStore();
	const now = ref(Date.now());
	const loading = ref(false);
	const error = ref('');
	const window = computed(() => upcomingScheduleWindow(now.value, store.timeZone));
	const covered = computed(() => guideCoversScheduleWindow(store.guide, window.value));
	const status = computed<UpcomingGuideStatus>(() => {
		if (loading.value) {
			return 'loading';
		}
		if (error.value) {
			return 'failed';
		}
		if (covered.value) {
			return 'ready';
		}
		return store.guide?.segmentLimitApplied ? 'incomplete' : 'unavailable';
	});
	let lastAttempt = '';
	let invalidated = false;
	let pending: Promise<void> | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	let disposed = false;

	/** Coalesce concurrent loads, letting the authoritative response cover in-flight events. */
	async function load(force = false): Promise<void> {
		invalidated ||= force;
		if (disposed || !enabled()) {
			return;
		}
		if (pending) {
			await pending;
			// The authoritative response includes changes announced while it was in flight.
			invalidated = false;
			return;
		}

		now.value = Date.now();
		const range = window.value;
		const key = `${range.timeZone}:${range.startDate}:${range.days}`;
		if (!invalidated && (covered.value || lastAttempt === key)) {
			return;
		}

		invalidated = false;
		lastAttempt = key;
		error.value = '';
		loading.value = true;
		pending = store.loadGuide(range.startDate, range.days).catch((cause) => {
			error.value = errorMessage(cause);
		}).finally(() => {
			pending = undefined;
			loading.value = false;
		});
		await pending;
		invalidated = false;
	}

	/** Catch up after time spent in the background, retrying a prior transport failure once. */
	function resume(): void {
		if (document.visibilityState === 'visible') {
			void load(Boolean(error.value));
		}
	}

	onMounted(() => {
		timer = setInterval(() => {
			if (document.visibilityState === 'visible') {
				void load();
			}
		}, SCHEDULE_SUMMARY_REFRESH_MS);
		document.addEventListener('visibilitychange', resume);
	});
	onBeforeUnmount(() => {
		disposed = true;
		clearInterval(timer);
		document.removeEventListener('visibilitychange', resume);
	});
	return { window, covered, status, error, load };
}
