import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AI_DEFAULT_RESULT_COUNT, AI_RESULT_COUNTS } from '@moirai/shared';
import { effectScope, reactive } from 'vue';
import { useProgramDraft } from '@web/components/programs/program-draft';

const mocks = vi.hoisted(() => ({ cancel: vi.fn(async () => {}) }));
vi.mock('@web/stores/authentication', () => ({ useAuthenticationStore: () => ({ state: { identity: { id: 'account' } } }) }));
vi.mock('@web/api', () => ({ api: { cancelAiGeneration: mocks.cancel } }));
let storage: Map<string, string>;
const scopes: ReturnType<typeof effectScope>[] = [];
beforeEach(() => {
	storage = new Map();
	mocks.cancel.mockClear();
	vi.stubGlobal('localStorage', {
		getItem: (key: string) => storage.get(key) ?? null,
		setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key),
	});
});
afterEach(() => {
	for (const scope of scopes.splice(0)) {
		scope.stop();
	}
	vi.unstubAllGlobals();
});

function editor() {
	const form = reactive({ type: 'content', sourceType: 'ai', name: '', libraryId: '', aiPrompt: '',
		aiSelectionPrompt: null, aiResultLimit: AI_DEFAULT_RESULT_COUNT, selectedItemIds: [], selectedItemSort: 'name',
		selectedItemSortDirection: 'asc', manualItemIds: [], strategy: 'sequential', seed: '',
		audioPreferences: {}, subtitlePreferences: {} });
	const scope = effectScope();
	scopes.push(scope);
	const draft = scope.run(() => useProgramDraft(form, () => 'saved', () => 'legacy', () => Boolean(form.name)))!;
	return { form, draft, scope };
}

it('migrates the actual legacy AI envelope including its generation ownership', async () => {
	const first = editor();
	const generation = crypto.randomUUID();
	storage.set('legacy', JSON.stringify({ version: 1, baseline: 'v1', generation,
		fields: { ...first.form, name: 'Earlier draft', aiPrompt: 'Keep this prompt' } }));
	await first.draft.open('v1', () => {});
	expect(first.form.name).toBe('Earlier draft');
	expect(first.draft.recovered.value).toBe(true);
	expect(first.draft.generation.value).toBe(generation);
	expect(storage.has('legacy')).toBe(false);
	expect(storage.size).toBe(1);
	first.scope.stop();
	const reopened = editor();
	await reopened.draft.open('v1', () => {});
	expect(reopened.form.aiPrompt).toBe('Keep this prompt');
	expect(reopened.draft.generation.value).toBe(generation);
	expect(mocks.cancel).not.toHaveBeenCalled();
});

it('retains requested result counts even when the server-save dirty state is clean', async () => {
	const first = editor();
	await first.draft.open('v1', () => {});
	first.form.aiResultLimit = AI_RESULT_COUNTS[0];
	first.scope.stop();
	const reopened = editor();
	await reopened.draft.open('v1', () => {});
	expect(reopened.form.aiResultLimit).toBe(AI_RESULT_COUNTS[0]);
});

it('restores cleared Program limits, prompts, filters, and inherited preferences', async () => {
	const saved = { aiSelectionPrompt: 'Earlier selection', queryItemLimit: 10,
		filter: { releaseYearFrom: 2000 }, audioPreferences: { language: 'eng' },
		subtitlePreferences: { creditsTemplateId: crypto.randomUUID() } };
	const pending = { aiSelectionPrompt: null, queryItemLimit: null,
		filter: { releaseYearFrom: null }, audioPreferences: { language: null },
		subtitlePreferences: { creditsTemplateId: null } };
	const first = editor();
	Object.assign(first.form, saved);
	await first.draft.open('v1', () => {});
	Object.assign(first.form, pending);
	expect(await first.draft.flush()).toBe(true);
	first.scope.stop();
	const reopened = editor();
	Object.assign(reopened.form, saved);
	await reopened.draft.open('v1', () => {});
	expect(reopened.form).toMatchObject(pending);
	expect(reopened.draft.warning.value).toBe('');
	expect(reopened.draft.unsafe.value).toBe(false);
});

it('cancels generation and removes recovery only on explicit clearing', async () => {
	const { draft } = editor();
	await draft.open('v1', () => {});
	const generation = crypto.randomUUID();
	draft.generation.value = generation;
	await draft.flush();
	expect(mocks.cancel).not.toHaveBeenCalled();
	draft.clear();
	expect(mocks.cancel).toHaveBeenCalledWith(generation);
	expect(storage.size).toBe(0);
});
