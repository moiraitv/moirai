import { ref } from 'vue';
import { z } from 'zod';
import { audioPreferencesSchema, catalogProgramItemFilterSchema, excludedItemIdsSchema, subtitlePreferencesSchema } from '@moirai/shared';
import { api } from '../../api';
import { useResourceDraft } from '../../composables/useResourceDraft';
import { legacyAiProgramDraftSchema } from './ai-program-draft';

/** A draft step retains blank quantities so the editor can recover incomplete edits. */
export interface SequenceDraftEntry {
	id: string;
	programId: string;
	count: number | '';
	chance: number | '';
}

/** Retain every Program source plus paid generation ownership, importing earlier AI-only drafts. */
export function useProgramDraft<T extends { metadataRows: unknown[] }>(
	form: T,
	identity: () => string,
	legacyKey: () => string,
	dirty: () => boolean,
	metadataDirty: () => boolean,
) {
	const generation = ref<string | null>(null);
	let baselineFields = '';
	let baselineProgramming = '';

	/** Compare the full scheduling draft, including browser-only options. */
	function programmingSnapshot(): string {
		return JSON.stringify({ ...form, metadataRows: undefined });
	}

	const retained = useResourceDraft({
		kind: 'program', identity,
		nullableSchema: z.object({ form: z.object({
			aiSelectionPrompt: z.string().nullable(), queryItemLimit: z.number().nullable(),
			filter: catalogProgramItemFilterSchema,
			audioPreferences: audioPreferencesSchema, subtitlePreferences: subtitlePreferencesSchema,
		}) }),
		// An unrelated draft must not reapply metadata from an older saved Program.
		capture: () => ({
			form: {
				...form,
				metadataRows: metadataDirty() ? form.metadataRows : undefined,
				programmingEdited: programmingSnapshot() !== baselineProgramming,
			},
			generation: generation.value,
		}),
		restore: fields => {
			const { metadataRows, programmingEdited, ...programming } = fields.form;
			// Older envelopes do not record intent and retain their existing recovery behavior.
			if (programmingEdited !== false) {
				Object.assign(form, programming);
			}
			if (Array.isArray(metadataRows)) {
				form.metadataRows = metadataRows;
			}
			if (programmingEdited !== false && 'sourceType' in fields.form && fields.form.sourceType === 'ai'
				&& !Object.hasOwn(fields.form, 'contentExclusions') && 'excludedItemIds' in fields.form) {
				const itemIds = excludedItemIdsSchema.safeParse(fields.form.excludedItemIds);
				if (itemIds.success) {
					Object.assign(form, { contentExclusions: { itemIds: itemIds.data, groupIds: [] } });
				}
			}
			generation.value = fields.generation;
		},
		dirty: () => JSON.stringify(form) !== baselineFields || Boolean(generation.value),
	});

	/** Load the authoritative baseline before applying current or legacy recovery fields. */
	async function open(version: string, reset: () => void, restore = true): Promise<void> {
		retained.pause();
		generation.value = null;
		reset();
		baselineFields = JSON.stringify(form);
		baselineProgramming = programmingSnapshot();
		await retained.open(version, restore);
		if (!restore) {
			return;
		}
		try {
			const raw = localStorage.getItem(legacyKey());
			if (raw) {
				const legacy = legacyAiProgramDraftSchema.parse(JSON.parse(raw));
				// A newer general draft takes precedence over an older AI-only draft.
				if (!retained.restored.value && !dirty() && !generation.value) {
					Object.assign(form, legacy.fields);
					generation.value = legacy.generation;
					retained.restored.value = true;
					retained.recovered.value = true;
					if (legacy.baseline !== version) {
						retained.warning.value = 'The saved program changed. Review your restored draft before saving.';
					}
				}
				if (await retained.flush()) {
					localStorage.removeItem(legacyKey());
				}
			}
		}
		catch {
			retained.warning.value = 'The earlier AI browser draft could not be restored.';
		}
	}

	/** Forget the draft and cancel generation only on save, reset, deletion, or explicit discard. */
	function clear(): void {
		retained.clear();
		if (generation.value) {
			void api.cancelAiGeneration(generation.value).catch(() => {});
			generation.value = null;
		}
		try {
			localStorage.removeItem(legacyKey());
		}
		catch {
			retained.warning.value = 'The earlier AI browser draft could not be cleared.';
		}
	}

	return { ...retained, generation, open, clear };
}
