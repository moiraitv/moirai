import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { effectScope, reactive } from 'vue';
import { z } from 'zod';
import { channelCreateSchema, channelScheduleConfigSchema, encodingProfileCreateSchema, libraryCreateSchema, scheduleTemplateCreateSchema } from '@moirai/shared';
import { useResourceDraft } from '@web/composables/useResourceDraft';

const mocks = vi.hoisted(() => ({
	account: { state: { identity: { id: 'account-a' } } },
	write: vi.fn(async () => {}), read: vi.fn(async () => ({})),
}));
vi.mock('@web/stores/authentication', () => ({ useAuthenticationStore: () => mocks.account }));
vi.mock('@web/resource-draft-files', () => ({ writeDraftFiles: mocks.write, readDraftFiles: mocks.read }));
let storage: Map<string, string>;
const scopes: ReturnType<typeof effectScope>[] = [];

beforeEach(() => {
	storage = new Map();
	mocks.account.state.identity.id = 'account-a';
	mocks.write.mockReset().mockResolvedValue();
	mocks.read.mockReset().mockResolvedValue({});
	vi.stubGlobal('localStorage', {
		getItem: (key: string) => storage.get(key) ?? null,
		setItem: (key: string, value: string) => storage.set(key, value),
		removeItem: (key: string) => storage.delete(key),
	});
});
afterEach(() => {
	for (const scope of scopes.splice(0)) {
		scope.stop();
	}
	vi.unstubAllGlobals();
});

function editor(identity = 'new', kind = 'program') {
	const scope = effectScope();
	scopes.push(scope);
	const fields = reactive({ name: '', count: 5 as number | string, items: [] as string[] });
	const baseline = JSON.stringify(fields);
	const files = reactive<Record<string, File>>({});
	const draft = scope.run(() => useResourceDraft({
		kind, identity: () => identity, capture: () => fields,
		restore: restored => Object.assign(fields, restored), dirty: () => JSON.stringify(fields) !== baseline || Object.keys(files).length > 0,
		files: () => ({ ...files }), restoreFiles: restored => {
			Object.assign(files, restored); 
		},
	}))!;
	return { fields, draft, files, scope };
}

function nullableEditor(initial: object, nullableSchema: z.ZodType) {
	const scope = effectScope();
	scopes.push(scope);
	const fields = reactive(structuredClone(initial));
	const baseline = JSON.stringify(initial);
	const draft = scope.run(() => useResourceDraft({
		kind: 'nullable', identity: () => 'saved', nullableSchema, capture: () => fields,
		restore: restored => Object.assign(fields, restored), dirty: () => JSON.stringify(fields) !== baseline,
	}))!;
	return { fields, draft, scope };
}

it.each([
	{
		name: 'disabled template filler', schema: z.object({ template: scheduleTemplateCreateSchema }),
		initial: { template: { name: 'Saved', defaultFiller: { programId: 'program', policy: 'best-fit-or-truncate' } } },
		pending: { template: { name: 'Pending', defaultFiller: null } },
	},
	{
		name: 'unlimited template drift and fall-through slots', schema: z.object({ template: scheduleTemplateCreateSchema }),
		initial: { template: { boundaries: [{ maxDriftSeconds: 300 }], slots: [{ programId: 'program' }] } },
		pending: { template: { boundaries: [{ maxDriftSeconds: null }], slots: [{ programId: null }] } },
	},
	{
		name: 'channel schedule assignments and unlimited layer drift', schema: z.object({ schedule: channelScheduleConfigSchema }),
		initial: { schedule: { defaultTemplateId: 'template', defaultProgramId: null, layers: [{ templateId: 'template', entryBoundary: { maxDriftSeconds: 300 } }] } },
		pending: { schedule: { defaultTemplateId: null, defaultProgramId: 'program', layers: [{ templateId: null, entryBoundary: { maxDriftSeconds: null } }] } },
	},
	{
		name: 'cleared channel profiles and inherited preferences', schema: z.object({ form: channelCreateSchema }),
		initial: { form: { encodingProfileId: 'profile', subtitlePreferences: { language: 'eng' }, audioPreferences: { title: 'English' } } },
		pending: { form: { encodingProfileId: null, subtitlePreferences: { language: null }, audioPreferences: { title: null } } },
	},
	{
		name: 'disabled encoding normalization', schema: encodingProfileCreateSchema,
		initial: { audio: { format: 'aac', loudness: { integratedTarget: -16 } }, video: { width: 1920, accel: 'automatic' } },
		pending: { audio: { format: null, loudness: null }, video: { width: null, accel: null } },
	},
	{
		name: 'cleared Library playback root', schema: libraryCreateSchema,
		initial: { sourceConfig: { scanRoot: '/media', playbackRoot: '/playback' } },
		pending: { sourceConfig: { scanRoot: '/media', playbackRoot: null } },
	},
	{
		name: 'nullable array entries', schema: z.object({ items: z.array(z.string().nullable()) }),
		initial: { items: ['program'] }, pending: { items: [null] },
	},
])('restores $name through retention and repeated reopen', async ({ schema, initial, pending }) => {
	const first = nullableEditor(initial, schema);
	await first.draft.open('v1');
	Object.assign(first.fields, pending);
	expect(await first.draft.flush()).toBe(true);
	first.scope.stop();
	for (let attempt = 0; attempt < 2; attempt += 1) {
		const reopened = nullableEditor(initial, schema);
		await reopened.draft.open('v1');
		expect(reopened.fields).toEqual(pending);
		expect(reopened.draft.warning.value).toBe('');
		expect(await reopened.draft.flush()).toBe(true);
		reopened.scope.stop();
	}
});

it.each([
	{ name: null, items: [] },
	{ name: 'Valid name', items: null },
	{ name: 'Valid name', items: [null] },
])('rejects null in non-nullable fields and array entries: %j', async pending => {
	const initial = { name: 'Saved', items: ['item'] };
	const schema = z.object({ name: z.string(), items: z.array(z.string()) });
	const first = nullableEditor(initial, schema);
	await first.draft.open('v1');
	Object.assign(first.fields, pending);
	first.scope.stop();
	const reopened = nullableEditor(initial, schema);
	await reopened.draft.open('v1');
	expect(reopened.fields).toEqual(initial);
	expect(reopened.draft.unsafe.value).toBe(true);
});

it('retains incomplete fields synchronously and restores without committing', async () => {
	const first = editor();
	await first.draft.open('v1');
	expect(first.draft.recovered.value).toBe(false);
	first.fields.name = 'Unfinished';
	first.fields.count = '';
	first.fields.items.push('selected');
	expect(storage.size).toBe(1);
	first.scope.stop();
	const reopened = editor();
	await reopened.draft.open('v1');
	expect(reopened.fields).toEqual(first.fields);
	expect(reopened.draft.recovered.value).toBe(true);
	expect(reopened.draft.unsafe.value).toBe(false);
});

it('isolates accounts, resource kinds, saved identities, and duplication sources', async () => {
	const first = editor('new:source-a');
	await first.draft.open('v1');
	first.fields.name = 'Private draft';
	for (const [identity, kind, account] of [
		['new:source-b', 'program', 'account-a'], ['saved', 'program', 'account-a'],
		['new:source-a', 'template', 'account-a'], ['new:source-a', 'program', 'account-b'],
	]) {
		mocks.account.state.identity.id = account!;
		const other = editor(identity, kind);
		await other.draft.open('v1');
		expect(other.fields.name).toBe('');
	}
});

it('warns about an updated saved baseline while keeping a recoverable draft', async () => {
	const first = editor('saved');
	await first.draft.open('v1');
	first.fields.name = 'Pending';
	first.scope.stop();
	const reopened = editor('saved');
	await reopened.draft.open('v2');
	expect(reopened.fields.name).toBe('Pending');
	expect(reopened.draft.warning.value).toContain('saved resource changed');
	expect(await reopened.draft.flush()).toBe(true);
	reopened.scope.stop();
	const again = editor('saved');
	await again.draft.open('v2');
	expect(again.draft.warning.value).toContain('saved resource changed');
});

it('clears recovery on reset/save and resumes tracking subsequent edits', async () => {
	const { draft, fields } = editor();
	await draft.open('v1');
	fields.name = 'Pending';
	draft.clear();
	fields.name = '';
	expect(storage.size).toBe(0);
	await draft.open('v1', false);
	fields.name = 'Later edit';
	expect(storage.size).toBe(1);
});

it('does not persist destructive view cleanup after an editor is paused', async () => {
	const { draft, fields } = editor();
	await draft.open('v1');
	fields.name = 'Keep';
	draft.pause();
	fields.name = '';
	const reopened = editor();
	await reopened.draft.open('v1');
	expect(reopened.fields.name).toBe('Keep');
});

it('protects fields when browser storage is unavailable or recovery is malformed', async () => {
	const { draft, fields } = editor();
	await draft.open('v1');
	vi.stubGlobal('localStorage', { setItem: () => {
		throw new Error('quota'); 
	} });
	fields.name = 'Keep open';
	expect(await draft.flush()).toBe(false);
	expect(draft.warning.value).toContain('could not be retained');
});

it('rejects incompatible recovery without assigning malformed fields', async () => {
	const { draft, fields } = editor();
	storage.set('moirai:resource-draft:account-a:program:new', JSON.stringify({
		version: 1, baseline: 'v1', fields: { name: null, count: 5, items: {} }, fileRevision: null,
	}));
	await draft.open('v1');
	expect(fields.name).toBe('');
	expect(draft.unsafe.value).toBe(true);
	expect(draft.recovered.value).toBe(false);
	expect(draft.warning.value).toContain('could not be fully restored');
});

it('reports complete recovery only after retained files have loaded successfully', async () => {
	const first = editor();
	await first.draft.open('v1');
	first.files.artwork = new File(['pixels'], 'image.png');
	await first.draft.flush();
	first.scope.stop();
	let release!: (files: Record<string, File>) => void;
	mocks.read.mockImplementationOnce(() => new Promise(resolve => {
		release = resolve;
	}));
	const reopened = editor();
	const opening = reopened.draft.open('v1');
	expect(reopened.draft.recovered.value).toBe(false);
	release({ artwork: first.files.artwork! });
	await opening;
	expect(reopened.draft.recovered.value).toBe(true);
	reopened.scope.stop();
	mocks.read.mockRejectedValueOnce(new Error('Missing files'));
	const failed = editor();
	await failed.draft.open('v1');
	expect(failed.draft.recovered.value).toBe(false);
	expect(failed.draft.unsafe.value).toBe(true);
});

it('writes files only on selection changes and waits for the latest write before dismissal', async () => {
	let release!: () => void;
	mocks.write.mockImplementationOnce(() => new Promise<void>(resolve => {
		release = resolve; 
	}));
	const { draft, fields, files } = editor();
	await draft.open('v1');
	files.artwork = new File(['pixels'], 'image.png');
	fields.name = 'First edit';
	fields.name = 'Second edit';
	expect(mocks.write).toHaveBeenCalledTimes(1);
	expect(draft.unsafe.value).toBe(true);
	const flushed = draft.flush();
	release();
	expect(await flushed).toBe(true);
	expect(mocks.write).toHaveBeenCalledTimes(1);
});

it('protects a retained draft when its file transaction fails', async () => {
	mocks.write.mockRejectedValueOnce(new Error('quota'));
	const { draft, files } = editor();
	await draft.open('v1');
	files.video = new File(['video'], 'fallback.mp4');
	expect(await draft.flush()).toBe(false);
	expect(draft.warning.value).toContain('Selected files could not be retained');
});

it('restores intentional removal of optional nested fields from saved slots', async () => {
	const original: { slots: Array<{ id: string; guide: { mode: string; artworkId?: string } }> }
		= { slots: [{ id: 'slot', guide: { mode: 'block', artworkId: 'saved' } }] };
	const baseline = JSON.stringify(original);
	const firstScope = effectScope();
	scopes.push(firstScope);
	const fields = reactive(structuredClone(original));
	const first = firstScope.run(() => useResourceDraft({
		kind: 'template', identity: () => 'saved', capture: () => fields,
		restore: restored => Object.assign(fields, restored), dirty: () => JSON.stringify(fields) !== baseline,
	}))!;
	await first.open(baseline);
	delete fields.slots[0]!.guide.artworkId;
	firstScope.stop();
	const reopenedScope = effectScope();
	scopes.push(reopenedScope);
	const reopened = reactive(structuredClone(original));
	const recovery = reopenedScope.run(() => useResourceDraft({
		kind: 'template', identity: () => 'saved', capture: () => reopened,
		restore: restored => Object.assign(reopened, restored), dirty: () => JSON.stringify(reopened) !== baseline,
	}))!;
	await recovery.open(baseline);
	expect(reopened.slots[0]!.guide).not.toHaveProperty('artworkId');
	expect(recovery.warning.value).toBe('');
	expect(recovery.unsafe.value).toBe(false);
});
