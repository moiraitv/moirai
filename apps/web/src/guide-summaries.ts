import { ref, shallowRef, watch } from 'vue';
import type { ScheduleGuide } from '@moirai/shared';
import type { ScheduleDaySummary, ScheduleSummaryWindow } from './channel-schedule-preview';
import { queryGuideSummaries } from './guide-worker';
import { errorMessage } from './error-message';

/** Refresh rolling counts without publishing a superseded response as the current preview. */
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
		error.value = '';
		if (!snapshot || !active) {
			summaries.value = new Map();
			loading.value = false;
			return;
		}

		// Keep the last counts so dead-air styling stays until this window resolves.
		loading.value = true;
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
