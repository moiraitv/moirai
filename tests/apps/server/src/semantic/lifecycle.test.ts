import { afterEach, describe, expect, it } from 'vitest';
import { SEMANTIC_HISTORY_LIMIT } from '@moirai/shared';
import { selectionStateRecordSchema } from '@moirai/shared/api-contracts';
import { selectProgram } from '@server/scheduling/selection.js';
import { fixture, vector } from './fixtures.js';
import type { SelectionStateRecord } from '@moirai/shared';

let current: Awaited<ReturnType<typeof fixture>> | undefined;
afterEach(async () => {
	await current?.close();
	current = undefined;
});
async function setup() {
	current = await fixture();
	await current.embeddings();
	return current;
}
function seed(state: Map<string, SelectionStateRecord>) {
	const value = [...state.values()].find((entry) => entry.value.type === 'similarity')!.value;
	if (value.type !== 'similarity') {
		throw new Error('Expected seed');
	}
	return value;
}

describe('persistent semantic selection', () => {
	it('persists and reuses embeddings, invalidates semantic changes, and ignores technical edits', async () => {
		const f = await setup();
		expect(f.semantic.reconcile()).toEqual([]);
		f.database.sqlite.prepare('UPDATE media_items SET plot=? WHERE id=?').run('Changed semantic plot', f.ids[0]);
		expect(f.semantic.catalog().vectors[f.ids[0]!]).toBeUndefined();
		const pending = f.semantic.reconcile();
		expect(pending.map((item) => item.id)).toEqual([f.ids[0]]);
		f.semantic.store(pending[0]!, vector());
		f.database.sqlite.prepare('UPDATE media_items SET technical_metadata=? WHERE id=?').run('{"codec":"new"}', f.ids[0]);
		expect(f.semantic.reconcile()).toEqual([]);
		f.reopen();
		expect(f.semantic.catalog().vectors[f.ids[0]!]).toHaveLength(384);
	});

	it('invalidates model/schema changes, rejects corrupt vectors and stale inference results', async () => {
		const f = await setup();
		f.database.sqlite.prepare('UPDATE media_embeddings SET input_version=0 WHERE media_id=?').run(f.ids[0]);
		expect(f.semantic.reconcile()).toHaveLength(1);
		const input = f.semantic.reconcile()[0]!;
		f.database.sqlite.prepare('UPDATE media_items SET plot=? WHERE id=?').run('New plot', input.id);
		expect(f.semantic.store(input, vector())).toBe(false);
		f.database.sqlite.prepare('UPDATE media_embeddings SET embedding=? WHERE media_id=?').run(Buffer.alloc(3), f.ids[1]);
		expect(f.semantic.catalog().vectors[f.ids[1]!]).toBeUndefined();
		f.database.sqlite.prepare('UPDATE media_embeddings SET model_revision=? WHERE media_id=?').run('old', f.ids[2]);
		expect(f.semantic.reconcile().map((item) => item.id)).toEqual(expect.arrayContaining([f.ids[0], f.ids[1], f.ids[2]]));
	});

	it('validates specific-item sources and prevents deletion or incompatible type changes', async () => {
		const f = await setup();
		await expect(f.repository.createProgram({ name: 'Bad', config: { type: 'similarity', sourceProgramId: f.program.id, quantity: 3, variety: 0 } })).rejects.toThrow(/Specific media items/);
		await expect(f.repository.updateProgram(f.source.id, { config: { type: 'sequence', entries: [{ id: f.program.id, programId: f.program.id, count: 1 }], repeat: true } })).rejects.toThrow(/type cannot/);
		await expect(f.repository.deleteProgram(f.source.id)).rejects.toThrow();
		expect((await f.repository.getProgram(f.program.id))?.config.type).toBe('similarity');
	});

	it('keeps membership/order and partial consumption across restart, settings, source, and corpus changes', async () => {
		const f = await setup();
		const context = await f.context();
		const first = selectProgram(f.program.id, f.key, new Map(), context)!;
		const original = structuredClone(seed(first.state));
		expect(original.seed.itemIds).toHaveLength(3);
		expect(original.seed.itemIds).not.toContain(f.ids[0]);
		f.commit([...first.state.values()]);
		f.reopen();
		expect(f.semantic.seeds()[0]!.itemIds).toEqual(original.seed.itemIds);
		await f.repository.updateProgram(f.program.id, { config: { type: 'similarity', sourceProgramId: f.source.id, quantity: 2, variety: 100 } });
		if (f.source.config.type !== 'content' || f.source.config.source.type !== 'collection') {
			throw new Error('Source');
		}
		await f.repository.updateProgram(f.source.id, { config: { ...f.source.config, source: { ...f.source.config.source, itemIds: [f.ids[0]!, f.ids[7]!] } } });
		const saved = new Map((await f.repository.getSelectionState(f.channel.id)).map((record) => [record.consumerKey, record]));
		const second = selectProgram(f.program.id, f.key, saved, await f.context())!;
		expect(seed(second.state).seed).toEqual(original.seed);
		expect(seed(second.state).consumedItemIds).toHaveLength(2);
		const third = selectProgram(f.program.id, f.key, second.state, await f.context())!;
		expect(seed(third.state).seed.generation).toBe(1);
		expect(seed(third.state).consumedItemIds).toHaveLength(3);
		f.commit([...third.state.values()]);
		const next = selectProgram(f.program.id, f.key, third.state, await f.context())!;
		expect(seed(next.state).seed.generation).toBe(2);
		expect(seed(next.state).seed.itemIds).toHaveLength(2);
		expect(seed(next.state).seed.config.variety).toBe(100);
		expect(seed(next.state).seed.sourceItemIds).toContain(f.ids[7]);
		expect(seed(next.state).seed.itemIds).not.toEqual(original.seed.itemIds);
	});

	it('replays a committed generation from an empty cursor without reranking and isolates previews', async () => {
		const f = await setup();
		const first = selectProgram(f.program.id, f.key, new Map(), await f.context())!;
		expect(f.semantic.seeds()).toEqual([]);
		f.commit([...first.state.values()]);
		const context = await f.context();
		context.catalog.semantic!.vectors = {};
		context.programs.delete(f.source.id);
		const replay = selectProgram(f.program.id, f.key, new Map(), context)!;
		expect(seed(replay.state).seed).toEqual(seed(first.state).seed);
		expect(selectProgram(f.program.id, f.key, new Map(), context, 1)).toBeNull();
		expect(f.semantic.seeds()).toHaveLength(1);
	});

	it('keeps unavailable entries unconsumed and isolates consumers while retaining occurrence progress', async () => {
		const f = await setup();
		const context = await f.context();
		const first = selectProgram(f.program.id, `${f.key}:2026-09-19`, new Map(), context)!;
		const blocked = seed(first.state).seed.itemIds[1]!;
		context.catalog.media.find((item) => item.id === blocked)!.availability = 'unconfirmed';
		const later = selectProgram(f.program.id, `${f.key}:2026-09-20`, first.state, context)!;
		expect(seed(later.state).consumedItemIds).not.toContain(blocked);
		expect(seed(later.state).seed.generation).toBe(1);
		expect(selectProgram(f.program.id, f.key, later.state, context)).toBeNull();
		const other = selectProgram(f.program.id, `${f.key}:other`, new Map(), context)!;
		expect(seed(other.state).seed.consumerKey).not.toBe(seed(later.state).seed.consumerKey);
	});

	it('waits for missing embeddings, tolerates failed anchors, and safely handles invalid sources', async () => {
		const f = await setup();
		const context = await f.context();
		delete context.catalog.semantic!.vectors[f.ids[0]!];
		expect(selectProgram(f.program.id, f.key, new Map(), context)).toBeNull();
		context.catalog.semantic!.vectors[f.ids[0]!] = vector();
		context.programs.delete(f.source.id);
		expect(selectProgram(f.program.id, f.key, new Map(), context)).toBeNull();
		context.programs.set(f.source.id, f.source);
		context.catalog.semantic!.pendingItemIds = [f.ids[0]!];
		expect(selectProgram(f.program.id, f.key, new Map(), context)).toBeNull();
	});

	it('rolls back conflicting concurrent proposals and rejects stale timeline commits', async () => {
		const f = await setup();
		const first = selectProgram(f.program.id, f.key, new Map(), await f.context())!;
		f.commit([...first.state.values()], null);
		expect(() => f.commit([...first.state.values()], null)).toThrow(/Stale timeline/);
		const changed = structuredClone(first.state);
		seed(changed).seed.itemIds.reverse();
		expect(() => f.commit([...changed.values()])).toThrow(/Stale semantic/);
		expect(f.semantic.seeds()[0]!.itemIds).toEqual(seed(first.state).seed.itemIds);
	});
});

it('uses edited source contents only for the next seed and continues an active seed after source loss', async () => {
	const f = await setup();
	const first = selectProgram(f.program.id, f.key, new Map(), await f.context())!;
	await f.repository.updateProgram(f.source.id, { config: {
		type: 'content', source: { type: 'collection', libraryId: f.library.id, itemIds: [f.ids[7]!], sort: { type: 'date-added', direction: 'asc' } }, strategy: { type: 'sequential' },
	} });
	await f.repository.updateProgram(f.program.id, { config: { type: 'similarity', sourceProgramId: f.source.id, quantity: 2, variety: 80 } });
	const context = await f.context();
	context.programs.delete(f.source.id);
	const second = selectProgram(f.program.id, f.key, first.state, context)!;
	expect(seed(second.state).seed.config).toMatchObject({ type: 'similarity', sourceProgramId: f.source.id });
	const third = selectProgram(f.program.id, f.key, second.state, context)!;
	context.programs.set(f.source.id, (await f.repository.getProgram(f.source.id))!);
	const next = selectProgram(f.program.id, f.key, third.state, context)!;
	expect(seed(next.state).seed.config).toMatchObject({ type: 'similarity', sourceProgramId: f.source.id });
	expect(seed(next.state).seed.sourceItemIds).toEqual([f.ids[7]]);
	expect(seed(next.state).seed.itemIds).not.toContain(f.ids[7]);
});

it('uses partial anchors and small completed pools, but waits while a candidate shortage is pending', async () => {
	const f = await setup();
	const context = await f.context();
	const source = context.programs.get(f.source.id)!;
	if (source.config.type !== 'content' || source.config.source.type !== 'collection') {
		throw new Error('Source');
	}
	source.config.source.itemIds.push(f.ids[1]!);
	const corpus = context.catalog.semantic!;
	delete corpus.vectors[f.ids[1]!];
	corpus.failedItemIds = [f.ids[1]!];
	const candidates = f.ids.slice(2);
	for (const id of candidates.slice(1)) {
		delete corpus.vectors[id];
	}
	corpus.pendingItemIds = [candidates[1]!];
	expect(selectProgram(f.program.id, f.key, new Map(), context)).toBeNull();
	corpus.pendingItemIds = [];
	context.issues = [];
	context.issueKeys.clear();
	context.issueIndex.clear();
	corpus.failedItemIds.push(...candidates.slice(1));
	const small = selectProgram(f.program.id, f.key, new Map(), context)!;
	expect(seed(small.state).seed.itemIds).toEqual([candidates[0]]);
	expect(context.issues.some((issue) => issue.message.includes('fewer than'))).toBe(true);
	const reused = selectProgram(f.program.id, f.key, small.state, context)!;
	expect(seed(reused.state).seed.generation).toBe(2);
	expect(seed(reused.state).seed.itemIds).toEqual([candidates[0]]);
});

it('keeps live eligibility despite a frozen committed catalog and supports nested sequence consumers', async () => {
	const f = await setup();
	const context = await f.context();
	context.catalog.semantic!.unavailableItems = { [f.ids[1]!]: true };
	const sequence = await f.repository.createProgram({ name: 'Sequence', config: { type: 'sequence',
		entries: [{ id: f.ids[0]!, programId: f.program.id, count: 1 }], repeat: true,
	} });
	context.programs.set(sequence.id, sequence);
	const result = selectProgram(sequence.id, `${f.key}:2026-09-19`, new Map(), context)!;
	expect(seed(result.state).seed.itemIds).not.toContain(f.ids[1]);
	expect(seed(result.state).seed.consumerKey).toContain(':entry:');
	expect(seed(result.state).seed.consumerKey).not.toContain('2026-09-19');
	expect(result.programAncestry).toEqual([sequence.id, f.program.id]);
});

it('reports empty and preparing states without counting source items as recommendations', async () => {
	const { schedulingProgramStatuses } = await import('@server/scheduling/status.js');
	const f = await setup();
	const context = await f.context();
	const status = () => schedulingProgramStatuses([...context.programs.values()], context.catalog).find((entry) => entry.programId === f.program.id)!;
	expect(status().availableItemCount).toBe(f.ids.length - 1);
	context.catalog.semantic!.vectors = { [f.ids[0]!]: vector() };
	expect(status().health).toBe('empty');
	context.catalog.semantic!.pendingItemIds = [f.ids[1]!];
	expect(status().health).toBe('degraded');
	expect(status().sourceLabel).toContain('Preparing');
});

it('persists bounded rotation history through restart, pruning, and immutable generation replay', async () => {
	const f = await setup();
	await f.repository.updateProgram(f.program.id, { config: { type: 'similarity', sourceProgramId: f.source.id, quantity: 1, variety: 0 } });
	const selected: string[] = [];
	for (let generation = 0; generation < 15; generation += 1) {
		const state = new Map((await f.repository.getSelectionState(f.channel.id)).map((record) => [record.consumerKey, record]));
		const next = selectProgram(f.program.id, f.key, state, await f.context())!;
		selected.push(next.media.id);
		expect(seed(next.state).recentSeeds?.length).toBe(Math.min(generation, SEMANTIC_HISTORY_LIMIT));
		f.commit([...next.state.values()]);
		f.semantic.pruneSeeds();
		f.reopen();
		const saved = await f.repository.getSelectionState(f.channel.id);
		expect(saved).toEqual([...next.state.values()]);
		expect(saved.map((record) => selectionStateRecordSchema.parse(record))).toEqual(saved);
	}
	expect(new Set(selected.slice(0, 7)).size).toBe(7);
	expect(selected.slice(7, 14)).toEqual(selected.slice(0, 7));
});


it('rejects replacing a saved similarity source without persisting any of the update', async () => {
	const f = await setup();
	const other = await f.repository.createProgram({ name: 'Other anchors', config: f.source.config });
	const before = await f.repository.getProgram(f.program.id);
	await expect(f.repository.updateProgram(f.program.id, {
		name: 'Rejected rename',
		config: { type: 'similarity', sourceProgramId: other.id, quantity: 2, variety: 80 },
	})).rejects.toMatchObject({ name: 'SchedulingValidationError' });
	f.reopen();
	expect(await f.repository.getProgram(f.program.id)).toEqual(before);

	const renamed = await f.repository.updateProgram(f.program.id, { name: 'Renamed recommendations' });
	expect(renamed?.name).toBe('Renamed recommendations');
	const updated = await f.repository.updateProgram(f.program.id, {
		config: { type: 'similarity', sourceProgramId: f.source.id, quantity: 2, variety: 80, softPreferences: 'Comedy' },
	});
	expect(updated?.config).toMatchObject({ sourceProgramId: f.source.id, quantity: 2, variety: 80, softPreferences: 'Comedy' });
});
