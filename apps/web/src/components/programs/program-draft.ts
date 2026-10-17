import { ref } from 'vue';
import { z } from 'zod';
import { audioPreferencesSchema, catalogProgramItemFilterSchema, subtitlePreferencesSchema } from '@moirai/shared';
import { api } from '../../api';
import { useResourceDraft } from '../../composables/useResourceDraft';
import { legacyAiProgramDraftSchema } from './ai-program-draft';

/** Retain every Program source plus paid generation ownership, importing earlier AI-only drafts. */
export function useProgramDraft<T extends object>(form: T, identity: () => string, legacyKey: () => string, dirty: () => boolean) {
	const generation = ref<string | null>(null);
	let baselineFields = '';
	const retained = useResourceDraft({
		kind: 'program', identity,
		nullableSchema: z.object({ form: z.object({
			aiSelectionPrompt: z.string().nullable(), queryItemLimit: z.number().nullable(),
			filter: catalogProgramItemFilterSchema,
			audioPreferences: audioPreferencesSchema, subtitlePreferences: subtitlePreferencesSchema,
		}) }),
		capture: () => ({ form, generation: generation.value }),
		restore: fields => {
			Object.assign(form, fields.form);
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
