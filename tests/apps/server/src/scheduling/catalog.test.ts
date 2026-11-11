import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { SchedulingProgram } from '@moirai/shared';
import { schedulingCatalogScope } from '@server/scheduling/catalog.js';

function program(config: SchedulingProgram['config'], id = randomUUID()): SchedulingProgram {
	return { id, name: id, config, createdAt: '', updatedAt: '' };
}

describe('scheduling catalog scopes', () => {
	it('follows sequence references and separates explicit items from whole-library queries', () => {
		const libraryId = randomUUID();
		const itemId = randomUUID();
		const explicit = program({
			type: 'content',
			source: {
				type: 'collection',
				libraryId,
				itemIds: [itemId],
				sort: { type: 'date-added', direction: 'asc' },
			},
			strategy: { type: 'sequential' },
		});
		const sequence = program({
			type: 'sequence',
			entries: [{ id: randomUUID(), programId: explicit.id, count: 1 }],
			repeat: true,
		});
		const unrelatedLibrary = randomUUID();
		const unrelated = program({
			type: 'content',
			source: { type: 'library-query', libraryId: unrelatedLibrary, kinds: [], genres: [] },
			strategy: { type: 'sequential' },
		});

		const scope = schedulingCatalogScope([explicit, sequence, unrelated], [sequence.id]);
		expect(scope.itemIds).toEqual([itemId]);
		expect(scope.sourceLibraryIds).toEqual([libraryId]);
		expect(scope.libraryIds).toEqual([]);
	});

	it('scopes catalog data to enabled Chance steps and independently scheduled sources', () => {
		const libraryId = randomUUID();
		const itemId = randomUUID();
		const theme = program({ type: 'theme', libraryId, theme: 'Space', variety: 35, quantity: 3 });
		const clip = program({ type: 'content', source: { type: 'item', itemId }, strategy: { type: 'sequential' } });
		const chance = program({ type: 'sequence', repeat: true, ordering: { type: 'chance', seed: '' }, entries: [
			{ id: randomUUID(), programId: theme.id, count: 0 },
			{ id: randomUUID(), programId: clip.id, count: 30 },
		] });
		const root = program({ type: 'sequence', repeat: true, entries: [{ id: randomUUID(), programId: chance.id, count: 1 }] });
		const programs = [root, chance, theme, clip];

		expect(schedulingCatalogScope(programs, [root.id])).toMatchObject({
			itemIds: [itemId],
			libraryIds: [], sourceLibraryIds: [],
		});
		expect(schedulingCatalogScope(programs, [root.id, theme.id]).libraryIds)
			.toEqual([libraryId]);
	});
});
