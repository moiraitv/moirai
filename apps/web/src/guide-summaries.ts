import { ref, shallowRef, watch } from 'vue';
import type { ScheduleGuide } from '@moirai/shared';
import type { ScheduleDaySummary, ScheduleSummaryWindow } from './channel-schedule-preview';
import { queryGuideSummaries } from './guide-worker';
import { errorMessage } from './error-message';

/** Refresh rolling counts without publishing stale responses or treating pending work as empty. */
export function useGuideSummaries(
	guide: () => ScheduleGuide | null,
	window: () => ScheduleSummaryWindow,
	enabled: () => boolean,
) {
	const summaries = shallowRef(new Map<string, ScheduleDaySummary>());
	const loading = ref(false);
	const error = ref('');
	watch([guide, window, enabled], async ([snapshot, range, active], _previous, onCleanup) => {
		let cancelled = false;
		onCleanup(() => {
			cancelled = true;
		});
		summaries.value = new Map();
		error.value = '';
		loading.value = Boolean(snapshot && active);
		if (!snapshot || !active) {
			return;
		}

		try {
			const result = await queryGuideSummaries(snapshot, range);
			if (!cancelled) {
				summaries.value = result;
			}
		}
		catch (cause) {
			if (!cancelled) {
				error.value = errorMessage(cause);
			}
		}
		finally {
			if (!cancelled) {
				loading.value = false;
			}
		}
	}, { immediate: true });
	return { summaries, loading, error };
}
