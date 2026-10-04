import { onScopeDispose, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { dateKey, shiftDateKey } from '../date-key';

/** Guide state needed to reconcile URL dates with bounded committed windows. */
interface GuideRouteState {
	timeZone: string;
	guideWeekStart: string;
}

/** Restore guide dates from browser navigation without duplicating explicit window loads. */
export function useGuideRouteDate(state: GuideRouteState, refresh: () => Promise<void>, onError: (cause: unknown) => void) {
	const route = useRoute();
	const router = useRouter();
	let ready = false;
	let active = true;
	let revision = 0;
	let pending = false;

	/** Interpret only real ISO calendar dates; absent or invalid values mean today. */
	function requestedDate(): string {
		const value = route.query.startDate;
		if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(value) && shiftDateKey(value, 0) === value) {
			return value;
		}
		return dateKey(new Date(), state.timeZone);
	}

	/** Replace invalid or expired dates after the store applies its existing range limits. */
	async function reconcile(): Promise<void> {
		const today = dateKey(new Date(), state.timeZone);
		const value = state.guideWeekStart === today ? undefined : state.guideWeekStart;
		if (route.query.startDate !== value) {
			await router.replace({ query: { ...route.query, startDate: value } });
		}
	}

	/** Reconcile only the current read, suppressing superseded results and failures. */
	async function load(operation: () => Promise<void>): Promise<boolean> {
		if (!active) {
			return false;
		}

		const current = ++revision;
		pending = true;
		try {
			await operation();
			if (current !== revision) {
				return false;
			}

			pending = false;
			await reconcile();
			return true;
		}
		catch (cause) {
			if (current === revision) {
				throw cause;
			}
			return false;
		}
		finally {
			if (current === revision) {
				pending = false;
			}
		}
	}

	/** Supersede an outstanding read even when history returns to the displayed date. */
	function restore(): void {
		if (active && ready && (pending || requestedDate() !== state.guideWeekStart)) {
			void refresh().catch(onError);
		}
	}

	/** Record a successfully loaded window as a deliberate browser history entry. */
	async function remember(): Promise<void> {
		const today = dateKey(new Date(), state.timeZone);
		await router.push({ query: { ...route.query, startDate: state.guideWeekStart === today ? undefined : state.guideWeekStart } });
	}

	/** Enable history restoration after the initial metadata and guide load. */
	function activate(): void {
		ready = active;
		restore();
	}

	watch(() => route.query.startDate, () => {
		revision += 1;
		restore();
	});
	onScopeDispose(() => {
		active = false;
		revision += 1;
		ready = false;
	});
	return { requestedDate, load, remember, activate };
}
