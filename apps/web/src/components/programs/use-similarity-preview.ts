import { onScopeDispose, ref, watch } from 'vue';
import type { ProgramConfig, SchedulingProgramStatus } from '@moirai/shared';
import { api } from '../../api';
import { liveEvents } from '../../live-events';
import { errorMessage } from '../../error-message';

/** Quiet interval after text input before a draft may enqueue refinement embeddings. */
export const SIMILARITY_TEXT_DEBOUNCE_MS = 750;
/** Shorter delay for source, quantity, and slider edits. */
export const SIMILARITY_CONTROL_DEBOUNCE_MS = 250;
/** Coalesce background progress without competing with interactive draft requests. */
export const SIMILARITY_REFRESH_INTERVAL_MS = 1_000;
/** Validated settings accepted by the read-only sample endpoint. */
type SimilarityConfig = Extract<ProgramConfig, { type: 'similarity' | 'theme' }>;

/** Own draft debounce, request cancellation, and serial background sample refreshes. */
export function useSimilarityPreview(
	readConfig: () => SimilarityConfig | null,
	readText: () => string,
	readSource: () => unknown,
) {
	const preview = ref<SchedulingProgramStatus | null>(null);
	const loading = ref(false);
	const error = ref('');
	let editTimer: ReturnType<typeof setTimeout> | undefined;
	let refreshTimer: ReturnType<typeof setTimeout> | undefined;
	let active: AbortController | undefined;
	let refreshPending = false;
	let disposed = false;
	let revision = 0;
	let previousText = readText();
	let textReadyAt = 0;

	/** Read the latest settled settings once, keeping background refreshes visually quiet. */
	async function load(foreground: boolean): Promise<void> {
		const config = readConfig();
		if (!config || disposed) {
			return;
		}
		const requestRevision = revision;
		const controller = new AbortController();
		active = controller;
		if (foreground || !preview.value) {
			loading.value = true;
		}
		try {
			const result = await api.previewSimilarityProgram(config, controller.signal);
			if (!controller.signal.aborted && requestRevision === revision && !disposed) {
				preview.value = result;
				error.value = '';
			}
		}
		catch (cause) {
			if (!controller.signal.aborted && requestRevision === revision && !disposed) {
				error.value = errorMessage(cause);
			}
		}
		finally {
			if (active === controller) {
				active = undefined;
				loading.value = false;
				if (refreshPending && !disposed) {
					refresh();
				}
			}
		}
	}

	/** Defer events during editing and serialize at most one follow-up after an in-flight read. */
	function refresh(): void {
		if (disposed || editTimer || !readConfig()) {
			return;
		}
		refreshPending = true;
		if (active || refreshTimer) {
			return;
		}
		refreshTimer = setTimeout(() => {
			refreshTimer = undefined;
			refreshPending = false;
			void load(false);
		}, SIMILARITY_REFRESH_INTERVAL_MS);
	}

	watch(() => JSON.stringify([readConfig(), readText(), readSource()]), () => {
		revision += 1;
		clearTimeout(editTimer);
		clearTimeout(refreshTimer);
		refreshTimer = undefined;
		refreshPending = false;
		active?.abort();
		active = undefined;
		error.value = '';
		const text = readText();
		if (text !== previousText) {
			textReadyAt = Date.now() + SIMILARITY_TEXT_DEBOUNCE_MS;
			previousText = text;
		}
		const config = readConfig();
		loading.value = Boolean(config);
		if (!config) {
			editTimer = undefined;
			preview.value = null;
			return;
		}
		// Moving a slider cannot shorten an outstanding text-edit debounce.
		const delay = Math.max(SIMILARITY_CONTROL_DEBOUNCE_MS, textReadyAt - Date.now());
		editTimer = setTimeout(() => {
			editTimer = undefined;
			void load(true);
		}, delay);
	}, { immediate: true });
	const unsubscribe = liveEvents.subscribe((event) => {
		if (event.type === 'embeddings.changed') {
			refresh();
		}
	});
	onScopeDispose(() => {
		disposed = true;
		unsubscribe();
		clearTimeout(editTimer);
		clearTimeout(refreshTimer);
		active?.abort();
	});
	return { preview, loading, error, refresh };
}
