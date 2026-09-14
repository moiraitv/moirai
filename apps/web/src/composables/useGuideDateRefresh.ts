import { onBeforeUnmount, onMounted } from 'vue';
import { dateKey } from '../date-key';

/** Check open guide views once a minute without polling the server during the same day. */
const DATE_CHECK_INTERVAL_MS = 60_000;

/** Refresh on a scheduling-date change, including after a suspended tab becomes visible. */
export function useGuideDateRefresh(
	state: { timeZone: string; guideLoaded: boolean; capabilitiesLoaded: boolean },
	refresh: () => Promise<void>,
	onError: (cause: unknown) => void,
): void {
	let observedDate = dateKey(new Date(), state.timeZone);
	let pending = false;
	let timer: ReturnType<typeof setInterval> | undefined;

	/** Retain the old date after failure so the next check can retry the rollover. */
	async function checkDate(): Promise<void> {
		if (document.visibilityState === 'hidden' || pending || !state.guideLoaded || !state.capabilitiesLoaded) {
			return;
		}
		const today = dateKey(new Date(), state.timeZone);
		if (today === observedDate) {
			return;
		}

		pending = true;
		try {
			await refresh();
			observedDate = today;
		}
		catch (cause) {
			onError(cause);
		}
		finally {
			pending = false;
		}
	}

	onMounted(() => {
		timer = setInterval(() => void checkDate(), DATE_CHECK_INTERVAL_MS);
		document.addEventListener('visibilitychange', checkDate);
	});
	onBeforeUnmount(() => {
		clearInterval(timer);
		document.removeEventListener('visibilitychange', checkDate);
	});
}
