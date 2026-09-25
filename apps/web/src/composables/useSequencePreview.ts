import { computed, onScopeDispose, ref, watch } from 'vue';
import { sequencePreviewSchema, type ProgramConfig, type SequencePreview, type TimelinePreview } from '@moirai/shared';
import { api } from '../api';
import { errorMessage } from '../error-message';

/** Match the scheduling editors' coalescing interval for automatic previews. */
const PREVIEW_UPDATE_DELAY_MS = 450;

/** Retain only effective scheduling settings; names and presentation never invalidate a sample. */
export function sequencePreviewSettings(config: ProgramConfig): SequencePreview['config'] | null {
	if (config.type !== 'sequence') {
		return null;
	}
	const ordering = config.ordering;
	return {
		type: 'sequence',
		entries: config.entries.map(({ id, programId, count }) => ({ id, programId, count })),
		repeat: config.repeat,
		ordering: ordering?.type === 'shuffled-blocks' || ordering?.type === 'shuffled-allocations'
			? { type: ordering.type, seed: ordering.seed.trim() }
			: { type: ordering?.type ?? 'ordered' },
	};
}

/** Own debounced, cancellable sample generation for one visible Sequence and discard late responses. */
export function useSequencePreview(config: () => ProgramConfig, identity: () => string) {
	const preview = ref<TimelinePreview | null>(null);
	const updating = ref(false);
	const queued = ref(false);
	const stale = ref(false);
	const error = ref('');
	const invalid = ref(false);
	const fingerprint = computed(() => JSON.stringify(sequencePreviewSettings(config())));
	let revision = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let controller: AbortController | undefined;
	let startDate: string | undefined;

	/** Cancel pending work without clearing the last successfully rendered sample. */
	function cancel(): void {
		revision += 1;
		clearTimeout(timer);
		timer = undefined;
		controller?.abort();
		updating.value = false;
		queued.value = false;
	}

	/** Refresh only valid scheduling inputs, preserving date and deterministic identities. */
	function refresh(delay = 0): void {
		cancel();
		const current = revision;
		const parsed = sequencePreviewSchema.safeParse({ id: identity(), config: JSON.parse(fingerprint.value),
			...(startDate ? { startDate } : {}) });
		invalid.value = !parsed.success;
		stale.value = preview.value !== null;
		error.value = '';
		if (!parsed.success) {
			return;
		}

		queued.value = true;
		timer = setTimeout(async () => {
			timer = undefined;
			queued.value = false;
			updating.value = true;
			controller = new AbortController();
			try {
				const result = await api.sequencePreview(parsed.data, controller.signal);
				if (current !== revision) {
					return;
				}
				startDate = result.startDate;
				preview.value = result;
				stale.value = false;
			}
			catch (cause) {
				if (current === revision) {
					error.value = errorMessage(cause);
				}
			}
			finally {
				if (current === revision) {
					updating.value = false;
				}
			}
		}, delay);
	}

	watch([fingerprint, identity], () => refresh(PREVIEW_UPDATE_DELAY_MS), { immediate: true });
	onScopeDispose(cancel);
	return { preview, updating, queued, stale, error, invalid, refresh };
}
