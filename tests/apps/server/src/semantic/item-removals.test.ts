import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { programCreateSchema, semanticMatchesRequestSchema, type SelectionStateRecord } from '@moirai/shared';
import { discoverOnDisk } from '@server/scanner/on-disk.js';
import { semanticMatches } from '@server/semantic/matches.js';
import { selectProgram } from '@server/scheduling/selection.js';
import { fixture, vector } from './fixtures.js';

for (const type of ['similarity', 'theme'] as const) {
	it(`${type} retains removals across restart, skips active entries, advances exhausted sets and restores eligibility`, async () => {
		const f = await fixture();
		try {
			await f.embeddings();
			const config = programCreateSchema.parse({ name: 'Review', config: type === 'theme'
				? { type, libraryId: f.library.id, theme: 'Space', quantity: 3 }
				: { type, sourceProgramId: f.source.id, quantity: 3 } }).config;
			const program = await f.repository.createProgram({ name: 'Review', config });
			f.semantic.preferences.reconcile();
			for (const job of f.semantic.preferences.pending()) {
				f.semantic.preferences.store(job.hash, vector());
			}
			f.repository.invalidateSchedulingCatalog();
			const first = selectProgram(program.id, f.key, new Map(), await f.context())!;
			const active = first.state.get(f.key)!.value;
			if (active.type !== 'similarity' || (config.type !== 'similarity' && config.type !== 'theme')) {
				throw new Error('Expected semantic state');
			}
			const original = structuredClone(active.seed);
			const removed = active.seed.itemIds.slice(1);
			const missing = randomUUID();
			f.commit([...first.state.values()]);
			await f.repository.updateProgram(program.id, { config: { ...config, excludedItemIds: [...removed, missing] } });
			f.reopen();
			const persisted = await f.repository.getProgram(program.id);
			expect(persisted!.config).toMatchObject({ excludedItemIds: [...removed, missing].sort() });
			const state = new Map((await f.repository.getSelectionState(f.channel.id)).map((row) => [row.consumerKey, row]));
			const context = await f.context();
			const next = selectProgram(program.id, f.key, state, context)!;
			expect(next.media).toBeDefined();
			expect(removed).not.toContain(next.media.id);
			expect(next.state.get(f.key)!.value).toMatchObject({ seed: { generation: original.generation + 1 } });
			expect(f.semantic.seeds().find((seed) => seed.consumerKey === f.key)).toEqual(original);

			// A partially consumed set skips just the removed entry and retains immutable membership.
			const partial = structuredClone(first.state) as Map<string, SelectionStateRecord>;
			const partialConfig = { ...config, excludedItemIds: [removed[0]!] };
			await f.repository.updateProgram(program.id, { config: partialConfig });
			f.repository.invalidateSchedulingCatalog();
			const continued = selectProgram(program.id, f.key, partial, await f.context())!;
			expect(continued.media.id).toBe(removed[1]);
			expect(continued.state.get(f.key)!.value).toMatchObject({ seed: original });

			await f.repository.updateProgram(program.id, { config: { ...config, excludedItemIds: [] } });
			f.repository.invalidateSchedulingCatalog();
			const restored = selectProgram(program.id, f.key, first.state, await f.context())!;
			expect(restored.media.id).toBe(removed[0]);
		}
		finally {
			await f.close();
		}
	});
}

it('reviews the complete relevant pool with stable search and paging without mutating state', async () => {
	const f = await fixture(22);
	try {
		await f.embeddings();
		const context = await f.context();
		const input = semanticMatchesRequestSchema.parse({ config: { ...f.program.config, quantity: 1 }, limit: 5 });
		const programs = [...context.programs.values()];
		const page = semanticMatches(input, f.program, programs, context.catalog);
		expect(page.total).toBe(f.ids.length - 1);
		expect(page.items).toHaveLength(5);
		const second = semanticMatches({ ...input, cursor: page.nextCursor }, f.program, programs, context.catalog);
		expect(second.items).toHaveLength(5);
		expect(second.items.map((item) => item.id).some((id) => page.items.some((item) => item.id === id))).toBe(false);
		const search = semanticMatches({ ...input, search: page.items[0]!.title }, f.program, programs, context.catalog);
		expect(search.items.map((item) => item.id)).toContain(page.items[0]!.id);
		const removed = semanticMatches({ ...input, config: { ...input.config, excludedItemIds: [page.items[0]!.id] } }, f.program, programs, context.catalog);
		expect(removed.total).toBe(page.total - 1);
		expect(removed.items.map((item) => item.id)).not.toContain(page.items[0]!.id);
		expect(f.semantic.seeds()).toEqual([]);
		expect(await f.repository.getSelectionState(f.channel.id)).toEqual([]);
	}
	finally {
		await f.close();
	}
});

for (const type of ['similarity', 'theme'] as const) {
	it(`${type} preserves removals through a real multipart rescan without committed seed aliases`, async () => {
		const f = await fixture();
		try {
			await f.embeddings();
			const config = programCreateSchema.parse({ name: 'Review aliases', config: type === 'theme'
				? { type, libraryId: f.library.id, theme: 'Space', quantity: 3 }
				: { type, sourceProgramId: f.source.id, quantity: 3 } }).config;
			if (config.type !== 'similarity' && config.type !== 'theme') {
				throw new Error('Expected semantic config');
			}
			const program = await f.repository.createProgram({ name: 'Review aliases', config });
			f.semantic.preferences.reconcile();
			for (const job of f.semantic.preferences.pending()) {
				f.semantic.preferences.store(job.hash, vector());
			}
			f.repository.invalidateSchedulingCatalog();
			const first = selectProgram(program.id, f.key, new Map(), await f.context())!;
			const active = first.state.get(f.key)!.value;
			if (active.type !== 'similarity') {
				throw new Error('Expected semantic state');
			}
			const original = structuredClone(active.seed);
			const removed = active.seed.itemIds[1]!;
			await f.repository.updateProgram(program.id, { config: { ...config, excludedItemIds: [removed] } });

			const discovery = await discoverOnDisk(f.library, { probeMedia: async () => ({ durationMilliseconds: 60_000, fileSizeBytes: 7, container: 'mp4', streams: [], resolution: null, tags: {} }) });
			const logicalId = randomUUID();
			const items = discovery.items.map((item) => item.id === removed
				? { ...item, id: logicalId, relativePath: 'Logical removed movie', stableKey: logicalId, aliasIds: [removed], multipartStatus: 'complete' as const } : item);
			await f.repository.reconcileScan(await f.repository.beginScan(f.library.id, 'initial'), discovery.groups, items, [], true);
			f.reopen();
			await f.embeddings();
			f.repository.invalidateSchedulingCatalog();

			const context = await f.context();
			expect(context.catalog.semantic!.seeds).toEqual([]);
			expect(context.catalog.mediaAliases?.[removed]).toBe(logicalId);
			const saved = context.programs.get(program.id)!;
			const input = semanticMatchesRequestSchema.parse({ config: saved.config });
			const review = semanticMatches(input, saved, [...context.programs.values()], context.catalog);
			expect(review.items.map((item) => item.id)).not.toContain(logicalId);
			expect(review.total).toBe(type === 'theme' ? f.ids.length - 1 : f.ids.length - 2);
			const fresh = selectProgram(program.id, f.key, new Map(), context)!;
			const value = fresh.state.get(f.key)!.value;
			if (value.type !== 'similarity') {
				throw new Error('Expected semantic state');
			}
			expect(value.seed.itemIds).not.toContain(logicalId);
			for (const filler of [false, true]) {
				const current = await f.context();
				if (filler) {
					current.fillerSelection = { fullBudgetSeconds: 120, allowTruncation: false };
				}
				const next = selectProgram(program.id, f.key, first.state, current)!;
				expect(next.media.id).not.toBe(logicalId);
				expect(next.state.get(f.key)!.value).toMatchObject({ seed: original });
			}
		}
		finally {
			await f.close();
		}
	});

	for (const removalIdentity of ['original', 'logical'] as const) {
		it(`${type} counts ${removalIdentity} removals and restorations without changing committed history`, async () => {
			const f = await fixture();
			try {
				await f.embeddings();
				const config = programCreateSchema.parse({ name: 'Review counts', config: type === 'theme'
					? { type, libraryId: f.library.id, theme: 'Space', quantity: 3 }
					: { type, sourceProgramId: f.source.id, quantity: 3 } }).config;
				if (config.type !== 'similarity' && config.type !== 'theme') {
					throw new Error('Expected semantic config');
				}
				const program = await f.repository.createProgram({ name: 'Review counts', config });
				f.semantic.preferences.reconcile();
				for (const job of f.semantic.preferences.pending()) {
					f.semantic.preferences.store(job.hash, vector());
				}
				f.repository.invalidateSchedulingCatalog();
				const first = selectProgram(program.id, f.key, new Map(), await f.context())!;
				const active = first.state.get(f.key)!.value;
				if (active.type !== 'similarity') {
					throw new Error('Expected semantic state');
				}
				const original = structuredClone(active.seed);
				const removed = original.itemIds[1]!;
				f.commit([...first.state.values()]);

				const discovery = await discoverOnDisk(f.library, { probeMedia: async () => ({ durationMilliseconds: 60_000, fileSizeBytes: 7, container: 'mp4', streams: [], resolution: null, tags: {} }) });
				const logicalId = randomUUID();
				const items = discovery.items.map((item) => item.id === removed
					? { ...item, id: logicalId, relativePath: 'Logical removed movie', stableKey: logicalId, aliasIds: [removed], multipartStatus: 'complete' as const } : item);
				await f.repository.reconcileScan(await f.repository.beginScan(f.library.id, 'initial'), discovery.groups, items, [], true);
				await f.repository.updateProgram(program.id, { config: { ...config, excludedItemIds: [removalIdentity === 'original' ? removed : logicalId] } });
				f.reopen();
				let context = await f.context();
				expect(context.catalog.semantic!.currentSets!.find((set) => set.consumerKey === f.key)).toMatchObject({ total: original.itemIds.length, remaining: 1 });
				const next = selectProgram(program.id, f.key, first.state, context)!;
				expect(next.media.id).toBe(original.itemIds[2]);
				f.commit([...next.state.values()]);
				f.reopen();
				context = await f.context();
				expect(context.catalog.semantic!.currentSets!.find((set) => set.consumerKey === f.key)).toMatchObject({ total: original.itemIds.length, remaining: 0 });
				expect(f.semantic.seeds().find((seed) => seed.consumerKey === f.key)).toEqual(original);
				const committed = (await f.repository.getSelectionState(f.channel.id)).find((record) => record.consumerKey === f.key)!;
				expect(committed.value).toMatchObject({ consumedItemIds: [first.media.id, next.media.id] });

				await f.repository.updateProgram(program.id, { config: { ...config, excludedItemIds: [] } });
				f.reopen();
				context = await f.context();
				expect(context.catalog.semantic!.currentSets!.find((set) => set.consumerKey === f.key)).toMatchObject({ total: original.itemIds.length, remaining: 1 });
				const restored = selectProgram(program.id, f.key, next.state, context)!;
				expect(restored.media.id).toBe(logicalId);
				expect(restored.state.get(f.key)!.value).toMatchObject({ seed: original });
			}
			finally {
				await f.close();
			}
		});
	}
}

it('advances past already prepared sets whose entire membership has been removed', async () => {
	const f = await fixture(12);
	try {
		await f.embeddings();
		const first = selectProgram(f.program.id, f.key, new Map(), await f.context())!;
		const active = first.state.get(f.key)!.value;
		if (active.type !== 'similarity' || f.program.config.type !== 'similarity') {
			throw new Error('Expected semantic state');
		}
		const futureItems = f.ids.filter((id) => id !== f.ids[0] && !active.seed.itemIds.includes(id)).slice(0, 3);
		const config = { ...f.program.config, excludedItemIds: [...active.seed.itemIds.slice(1), ...futureItems] };
		await f.repository.updateProgram(f.program.id, { config });
		f.repository.invalidateSchedulingCatalog();
		const context = await f.context();
		context.catalog.semantic!.seeds.push({ ...structuredClone(active.seed), generation: 2, itemIds: futureItems });
		const next = selectProgram(f.program.id, f.key, first.state, context)!;
		expect(next.media).toBeDefined();
		expect(config.excludedItemIds).not.toContain(next.media.id);
		expect(next.state.get(f.key)!.value).toMatchObject({ seed: { generation: 3 } });
	}
	finally {
		await f.close();
	}
});

it('distinguishes preparing concepts from failed preparation in match review', async () => {
	const f = await fixture();
	try {
		await f.embeddings();
		const context = await f.context();
		const input = semanticMatchesRequestSchema.parse({ config: { ...f.program.config, hardExclusions: ['Space'] } });
		const draft = { ...f.program, config: input.config };
		const review = () => semanticMatches(input, draft, [...context.programs.values()], context.catalog);
		expect(review()).toMatchObject({ pending: true, preparationFailed: false, items: [] });
		context.catalog.semantic!.preferences ??= {};
		context.catalog.semantic!.preferences['Space'] = { status: 'failed' };
		expect(review()).toMatchObject({ pending: false, preparationFailed: true, items: [] });
		expect(review().message).toContain('Could not prepare');
	}
	finally {
		await f.close();
	}
});
