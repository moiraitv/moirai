import { computed, onBeforeUnmount, shallowReactive, watch, type Ref } from 'vue';
import { guideArtworkUrl, type ScheduleSlot } from '@moirai/shared';
import { api } from '../../api';

/** A local image selection survives failed saves without repeating successful uploads. */
interface PendingArtwork {
	file: File;
	url: string;
	artworkId?: string;
}

/** Own draft-only files and object URLs until the template is saved, reset, or discarded. */
export function useGuideArtworkDraft(slots: Ref<ScheduleSlot[]>) {
	const pending = shallowReactive(new Map<string, PendingArtwork>());
	const hasPending = computed(() => pending.size > 0);

	/** Release the previous local preview when replacing or clearing a selection. */
	function clear(slotId: string): void {
		const previous = pending.get(slotId);
		if (previous) {
			URL.revokeObjectURL(previous.url);
			pending.delete(slotId);
		}
	}

	/** Clear all local selections on reset, navigation, or editor disposal. */
	function reset(): void {
		for (const id of pending.keys()) {
			clear(id);
		}
	}

	/** Choose a file or remove the image from the saveable slot draft. */
	function select(slot: ScheduleSlot, file: File | null): void {
		clear(slot.id);
		if (slot.guide?.mode !== 'block') {
			return;
		}
		if (file) {
			pending.set(slot.id, { file, url: URL.createObjectURL(file) });
		}
		else {
			delete slot.guide.artworkId;
		}
	}

	/** Prefer the local image until its immutable upload reference is persisted. */
	function preview(slot: ScheduleSlot): string | undefined {
		return pending.get(slot.id)?.url ?? (slot.guide?.mode === 'block' && slot.guide.artworkId
			? guideArtworkUrl(slot.guide.artworkId) : undefined);
	}

	/** Upload only active selections, preserving successful references across save retries. */
	async function upload(): Promise<void> {
		for (const slot of slots.value) {
			const selection = pending.get(slot.id);
			if (!selection || slot.guide?.mode !== 'block') {
				continue;
			}
			selection.artworkId ??= (await api.uploadGuideArtwork(selection.file)).artworkId;
			slot.guide.artworkId = selection.artworkId;
		}
	}

	watch(() => slots.value.map(slot => slot.guide?.mode === 'block' ? slot.id : null), (active) => {
		for (const id of pending.keys()) {
			if (!active.includes(id)) {
				clear(id);
			}
		}
	});
	onBeforeUnmount(reset);
	return { hasPending, select, preview, upload, reset };
}
