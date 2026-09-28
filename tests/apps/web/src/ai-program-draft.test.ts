import { afterEach, expect, it, vi } from 'vitest';
import { effectScope, reactive } from 'vue';
import { randomUUID } from 'node:crypto';
import { useAiProgramDraft } from '../../../../apps/web/src/components/programs/ai-program-draft';

afterEach(() => vi.unstubAllGlobals());

it('restores incomplete AI fields and a pending identity, scoped to the current account/program', () => {
	const storage = new Map<string, string>();
	vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null,
		setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
	const fields = { type: 'content', sourceType: 'ai', name: '', libraryId: randomUUID(), aiPrompt: '', aiSelectionPrompt: null as string | null,
		selectedItemIds: [], selectedItemSort: 'date-added', selectedItemSortDirection: 'asc', manualItemIds: [],
		strategy: 'sequential', seed: '', audioPreferences: {}, subtitlePreferences: {} };
	const scope = effectScope();
	const form = reactive({ ...fields });
	const draft = scope.run(() => useAiProgramDraft(form, () => 'account-a:new'))!;
	draft.open('', () => {});
	form.name = 'Unfinished draft';
	form.aiSelectionPrompt = 'Earlier prompt';
	const id = randomUUID();
	draft.generation.value = id;
	scope.stop();

	const restoredScope = effectScope();
	const restored = reactive({ ...fields });
	const other = restoredScope.run(() => useAiProgramDraft(restored, () => 'account-b:new'))!;
	other.open('', () => {});
	expect(restored.name).toBe('');
	const reload = restoredScope.run(() => useAiProgramDraft(restored, () => 'account-a:new'))!;
	reload.open('', () => {});
	expect(restored.name).toBe('Unfinished draft');
	expect(restored.aiSelectionPrompt).toBe('Earlier prompt');
	expect(reload.generation.value).toBe(id);
	// A completed selection clears its pending identity before Save removes browser recovery state.
	reload.generation.value = null;
	reload.clear();
	expect(storage.has('account-a:new')).toBe(false);
	restoredScope.stop();
});

it('warns when storage is unavailable instead of silently claiming recovery', () => {
	vi.stubGlobal('localStorage', { getItem: () => {
		throw new Error('disabled');
	} });
	const scope = effectScope();
	const draft = scope.run(() => useAiProgramDraft(reactive({}), () => 'draft'))!;
	draft.open('', () => {});
	expect(draft.warning.value).toContain('could not be restored');
	scope.stop();
});
