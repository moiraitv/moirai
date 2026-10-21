import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { MAX_EXCLUDED_MEDIA_ITEMS, semanticMatchesRequestSchema } from '@moirai/shared';
import { semanticMatches } from '@server/semantic/matches.js';
import { schedulingRead } from '@server/scheduling/read-jobs.js';
import { fixture, vector } from './fixtures.js';

for (const type of ['similarity', 'theme'] as const) {
	it(`${type} preserves review ranking across removals that would admit stronger preferred candidates`, async () => {
		const f = await fixture(9);
		try {
			await f.embeddings();
			const context = await f.context();
			const programs = [...context.programs.values()];
			const corpus = context.catalog.semantic!;
			const strongest = f.ids[1]!;
			const newlyEligible = f.ids[8]!;
			corpus.preferences = { Anchor: { status: 'ready', vector: vector() },
				Preference: { status: 'ready', vector: vector(0, 1) } };
			f.ids.forEach((id, index) => {
				corpus.vectors[id] = index < 2 ? vector() : index === 8
					? vector(0.8, 0.6) : vector(0.9, -Math.sqrt(1 - 0.9 ** 2));
			});
			const input = semanticMatchesRequestSchema.parse({ config: {
				...(type === 'theme' ? { type, libraryId: f.library.id, theme: 'Anchor' }
					: { type, sourceProgramId: f.source.id }),
				quantity: 3, softPreferences: 'Preference', excludedItemIds: [f.ids[0]],
			}, limit: 5 });
			const draft = { ...f.program, config: input.config };
			const first = semanticMatches(input, draft, programs, context.catalog);
			expect(first.total).toBe(7);
			expect(first.items[0]!.id).toBe(strongest);

			const changed = { ...input, additionalExcludedItemIds: [strongest] };
			const currentConfig = { ...input.config, excludedItemIds: [f.ids[0]!, strongest] };
			const next = semanticMatches(
				{ ...changed, cursor: String(Number(first.nextCursor) - 1) },
				{ ...draft, config: currentConfig },
				programs,
				context.catalog,
			);
			const reviewed = [...first.items.filter((item) => item.id !== strongest), ...next.items].map((item) => item.id);
			expect(next.total).toBe(6);
			expect(next.nextCursor).toBeNull();
			expect(reviewed).toHaveLength(6);
			expect(new Set(reviewed).size).toBe(reviewed.length);
			expect(reviewed).not.toContain(newlyEligible);

			const restarted = semanticMatches(
				{ ...input, config: currentConfig },
				{ ...draft, config: currentConfig },
				programs,
				context.catalog,
			);
			expect(restarted.total).toBe(7);
			expect(restarted.items[0]!.id).toBe(newlyEligible);

			// Exercise the worker read path with the same vectors persisted in SQLite.
			f.semantic.storeBatch(f.semantic.inputs().map((input) => ({ input, vector: corpus.vectors[input.id]! })));
			await f.semantic.preferences.catalog(['Anchor', 'Preference']);
			for (const job of f.semantic.preferences.pending()) {
				f.semantic.preferences.store(job.hash, corpus.preferences[job.text]!.vector!);
			}
			f.repository.invalidateSchedulingCatalog();
			const worker = await schedulingRead(f.repository, { kind: 'semantic-matches',
				input: { ...changed, cursor: String(Number(first.nextCursor) - 1) } });
			expect(JSON.parse(worker.body)).toMatchObject({ total: next.total, items: next.items, nextCursor: null });
			expect(f.semantic.seeds()).toEqual([]);
		}
		finally {
			await f.close();
		}
	});
}

it('bounds original and additional review removals by the same program limit', () => {
	const ids = Array.from({ length: MAX_EXCLUDED_MEDIA_ITEMS }, () => randomUUID());
	const split = Math.floor(ids.length / 2);
	const request = { config: { type: 'theme', libraryId: randomUUID(), theme: 'Space', excludedItemIds: ids.slice(0, split) },
		additionalExcludedItemIds: ids.slice(split) };
	expect(semanticMatchesRequestSchema.safeParse(request).success).toBe(true);
	expect(semanticMatchesRequestSchema.safeParse({ ...request,
		additionalExcludedItemIds: [...request.additionalExcludedItemIds, randomUUID()] }).success).toBe(false);
});
