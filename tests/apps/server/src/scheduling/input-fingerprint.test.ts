import { expect, it } from 'vitest';
import type { SchedulingProgram } from '@moirai/shared';
import { inputFingerprint, InputFingerprintContext } from '@server/scheduling/input-fingerprint.js';
import { stableJsonFingerprint } from '@server/stable-json.js';

it('retains canonical fingerprint bytes with shared objects, array order and optional values', () => {
	const shared = { title: 'A "title"', missing: undefined, nested: { z: null, a: [true, false, 1.5] } };
	const values = [{ first: shared, second: shared }, [shared, shared], { Z: 1, a: 2, 'ä': 3 }, null, []];
	const context = new InputFingerprintContext();
	for (const value of values) {
		expect(context.fingerprint(value)).toBe(stableJsonFingerprint(value));
		expect(context.fingerprint(value)).toBe(stableJsonFingerprint(value));
	}
});

it('retains rejection of a non-JSON root value', () => {
	expect(() => new InputFingerprintContext().fingerprint(undefined)).toThrow(TypeError);
});

it('reuses identical catalog scopes across channels without inspecting media again', () => {
	let reads = 0;
	const media = {
		id: 'item', groupId: null, availability: 'available',
		get libraryId() {
			reads += 1;
			return 'library';
		},
	};
	const catalog = { media: [media], groupParents: {}, groupTitles: {}, libraryNames: { library: 'Movies' } } as unknown as import('@moirai/shared').SchedulingCatalog;
	const context = new InputFingerprintContext();
	const first = context.scope(catalog, new Set(['library']), new Set(), new Set());
	const inspected = reads;
	expect(inspected).toBeGreaterThan(0);
	expect(context.scope(catalog, new Set(['library']), new Set(), new Set())).toBe(first);
	expect(reads).toBe(inspected);
	expect(context.scope({ ...catalog }, new Set(['library']), new Set(), new Set())).not.toBe(first);
	expect(reads).toBeGreaterThan(inspected);
});


it('normalizes the enabled duplicate policy while distinguishing channel opt-out', () => {
	const schedule = { channelId: 'channel', defaultTemplateId: 'template', layers: [], defaultFiller: null, createdAt: '', updatedAt: '' };
	const catalog = { media: [], groupParents: {}, groupTitles: {}, libraryNames: {}, libraryAvailability: {} };
	const enabled = inputFingerprint(schedule, [], [], catalog);
	expect(inputFingerprint({ ...schedule, avoidCrossChannelDuplicates: true }, [], [], catalog)).toBe(enabled);
	expect(inputFingerprint({ ...schedule, avoidCrossChannelDuplicates: false }, [], [], catalog)).not.toBe(enabled);
});

it.each(['legacy', 'current'] as const)('invalidates a committed input when a %s exclusion resolves to selected media', mode => {
	const source = { type: 'ai', libraryId: 'library', prompt: 'Movies', itemIds: ['selected'],
		sort: { type: 'date-added', direction: 'asc' } } as const;
	const program: SchedulingProgram = { id: 'program', name: 'AI', createdAt: '', updatedAt: '', config: {
		type: 'content', strategy: { type: 'sequential' }, source: { ...source, itemIds: [...source.itemIds],
			...(mode === 'legacy' ? { excludedItemIds: ['absorbed'] } : { exclusions: { itemIds: ['absorbed'], groupIds: [] } }) },
	} };
	const schedule = { channelId: 'channel', defaultTemplateId: null, defaultProgramId: program.id, layers: [], defaultFiller: null, createdAt: '', updatedAt: '' };
	const catalog = { media: [], groupParents: {}, groupTitles: {}, libraryNames: {}, libraryAvailability: {} };
	const committed = inputFingerprint(schedule, [], [program], catalog);
	expect(inputFingerprint(schedule, [], [program], { ...catalog, mediaAliases: { unrelated: 'selected' } })).toBe(committed);
	expect(inputFingerprint(schedule, [], [program], { ...catalog, mediaAliases: { absorbed: 'selected' } })).not.toBe(committed);
});

it('ignores edits to a source while its Chance step is disabled', () => {
	const config = { type: 'theme', libraryId: 'library', theme: 'Space', variety: 35, quantity: 3 } as const;
	const theme: SchedulingProgram = { id: 'theme', name: 'Theme', createdAt: '', updatedAt: '', config };
	const edited: SchedulingProgram = { ...theme, config: { ...config, theme: 'Ocean' } };
	const schedule = { channelId: 'channel', defaultTemplateId: null, defaultProgramId: 'sequence', layers: [], defaultFiller: null, createdAt: '', updatedAt: '' };
	const catalog = { media: [], groupParents: {}, groupTitles: {}, libraryNames: {}, libraryAvailability: {} };
	const fingerprint = (count: number, source: SchedulingProgram) => inputFingerprint(schedule, [], [
		{ id: 'sequence', name: 'Chance', createdAt: '', updatedAt: '', config: { type: 'sequence', repeat: true,
			ordering: { type: 'chance', seed: '' }, entries: [{ id: 'step', programId: source.id, count }] } },
		source,
	], catalog);

	const disabled = fingerprint(0, theme);
	const enabled = fingerprint(30, theme);
	expect(fingerprint(0, edited)).toBe(disabled);
	expect(enabled).not.toBe(disabled);
	expect(fingerprint(30, edited)).not.toBe(enabled);
});
