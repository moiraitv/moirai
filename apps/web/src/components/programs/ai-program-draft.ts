import { ref, watch } from 'vue';
import { z } from 'zod';
import { audioPreferencesSchema, subtitlePreferencesSchema, MAX_EXPLICIT_MEDIA_ITEMS, AI_DEFAULT_RESULT_COUNT, aiResultCountSchema } from '@moirai/shared';
import { api } from '../../api';

/** Persist only editable AI fields; incomplete names and prompts must survive reload too. */
export const aiProgramDraftFieldsSchema = z.object({
	type: z.literal('content'), sourceType: z.literal('ai'), name: z.string().max(200),
	libraryId: z.union([z.uuid(), z.literal('')]), aiPrompt: z.string().max(2000),
	aiSelectionPrompt: z.string().max(2000).nullable().default(null),
	aiResultLimit: aiResultCountSchema.default(AI_DEFAULT_RESULT_COUNT),
	selectedItemIds: z.array(z.uuid()).max(MAX_EXPLICIT_MEDIA_ITEMS),
	selectedItemSort: z.enum(['date-added', 'name', 'release-date', 'manual']),
	selectedItemSortDirection: z.enum(['asc', 'desc']), manualItemIds: z.array(z.uuid()).max(MAX_EXPLICIT_MEDIA_ITEMS),
	strategy: z.enum(['sequential', 'shuffle', 'random', 'weighted-random']),
	seed: z.string().max(200), audioPreferences: audioPreferencesSchema, subtitlePreferences: subtitlePreferencesSchema,
});
/** Version browser drafts independently of server program contracts. */
const draftSchema = z.object({ version: z.literal(1), baseline: z.string(), generation: z.uuid().nullable(), fields: aiProgramDraftFieldsSchema });

/**
 * Save AI editor fields synchronously before a reload can lose them. Scope storage to the signed-in
 * administrator and program; explicit save/reset/discard removes the draft, while closing retains it.
 */
export function useAiProgramDraft(form: object, key: () => string) {
	const generation = ref<string | null>(null);
	const warning = ref('');
	let ready = false;
	let baseline = '';

	/** Save validated fields without letting unavailable browser storage break editing. */
	function persist(): void {
		if (!ready) {
			return;
		}
		const fields = aiProgramDraftFieldsSchema.safeParse(form);
		try {
			if (fields.success) {
				localStorage.setItem(key(), JSON.stringify({ version: 1, baseline, generation: generation.value, fields: fields.data }));
			}
			else if ('sourceType' in form && form.sourceType === 'ai') {
				warning.value = 'Draft could not be saved. Check the fields and keep this page open.';
			}
			else {
				localStorage.removeItem(key());
			}
		}
		catch {
			warning.value = 'Draft could not be saved in this browser. Keep this page open.';
		}
	}

	/** Open the current saved baseline, then restore its browser draft before rendering the editor. */
	function open(version: string, reset: () => void, restore = true): void {
		ready = false;
		generation.value = null;
		reset();
		baseline = version;
		warning.value = '';
		try {
			const raw = restore ? localStorage.getItem(key()) : null;
			if (raw) {
				const draft = draftSchema.parse(JSON.parse(raw));
				Object.assign(form, draft.fields);
				generation.value = draft.generation;
				if (draft.baseline !== baseline) {
					warning.value = 'The saved program changed. Review your restored draft before saving.';
				}
			}
		}
		catch {
			warning.value = 'The browser draft could not be restored.';
		}
		ready = true;
	}

	/** Forget a saved or explicitly discarded draft and cancel work that no longer has an owner. */
	function clear(): void {
		ready = false;
		const id = generation.value;
		generation.value = null;
		if (id) {
			void api.cancelAiGeneration(id).catch(() => {});
		}
		try {
			localStorage.removeItem(key());
		}
		catch {
			warning.value = 'The browser draft could not be cleared.';
		}
	}

	watch([() => form, generation], persist, { deep: true, flush: 'sync' });
	return { generation, warning, open, clear, persist };
}
