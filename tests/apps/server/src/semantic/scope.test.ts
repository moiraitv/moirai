import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { libraryCreateSchema } from '@moirai/shared';
import { SemanticRepository } from '@server/repository/semantic.js';
import { SemanticPreferenceRepository } from '@server/repository/semantic-preferences.js';
import { selectProgram } from '@server/scheduling/selection.js';
import { fixture } from './fixtures.js';

it('avoids semantic reads for content-only roots and scopes nested similarity corpora and seed history', async () => {
	const f = await fixture();
	try {
		await f.embeddings();
		const otherLibrary = await f.repository.createLibrary(libraryCreateSchema.parse({ name: 'Other', typeKey: 'movies', sourceType: 'on-disk', sourceConfig: { scanRoot: f.root } }));
		f.database.sqlite.prepare("UPDATE libraries SET source_availability='available' WHERE id=?").run(otherLibrary.id);
		const unrelatedIds = f.ids.slice(4);
		f.database.sqlite.prepare('UPDATE media_items SET library_id=? WHERE id IN (SELECT value FROM json_each(?))').run(otherLibrary.id, JSON.stringify(unrelatedIds));
		const source = await f.repository.createProgram({ name: 'Other anchors', config: { type: 'content', source: { type: 'collection', libraryId: otherLibrary.id, itemIds: [unrelatedIds[0]!], sort: { type: 'name', direction: 'asc' } }, strategy: { type: 'sequential' } } });
		const other = await f.repository.createProgram({ name: 'Other similar', config: { type: 'similarity', sourceProgramId: source.id, quantity: 1, variety: 35 } });
		const sequence = await f.repository.createProgram({ name: 'Nested', config: { type: 'sequence', repeat: true, entries: [{ id: randomUUID(), programId: f.program.id, count: 1 }] } });
		const original = selectProgram(f.program.id, f.key, new Map(), await f.context())!;
		const unrelated = selectProgram(other.id, `${f.key}:other`, original.state, await f.context())!;
		f.commit([...unrelated.state.values()]);
		const programs = await f.repository.listPrograms();
		const corpusReads = vi.spyOn(SemanticRepository.prototype, 'catalog');
		const preferenceReads = vi.spyOn(SemanticPreferenceRepository.prototype, 'catalog');
		try {
			const content = await f.repository.getSchedulingCatalog(programs, [f.source.id]);
			expect(content.semantic).toBeUndefined();
			expect(content.media.map((item) => item.id)).toEqual([f.ids[0]]);
			expect(corpusReads).not.toHaveBeenCalled();
			expect(preferenceReads).not.toHaveBeenCalled();
			const catalog = await f.repository.getSchedulingCatalog(programs, (function* () {
				yield sequence.id; 
			})());
			expect(Object.keys(catalog.semantic!.vectors).sort()).toEqual(f.ids.slice(0, 4).sort());
			expect(catalog.semantic!.seeds.map((seed) => seed.programId)).toEqual([f.program.id]);
			expect(catalog.semantic!.currentSets?.map((set) => set.programId)).toEqual([f.program.id]);
			expect(catalog.media.some((item) => unrelatedIds.includes(item.id))).toBe(false);
			expect(corpusReads).toHaveBeenCalledTimes(1);
			expect(preferenceReads).toHaveBeenCalledTimes(1);
			await f.repository.getSchedulingCatalog(programs, [sequence.id]);
			expect(corpusReads).toHaveBeenCalledTimes(1);
			expect(preferenceReads).toHaveBeenCalledTimes(1);
			await f.repository.updateProgram(f.program.id, { config: { type: 'similarity', sourceProgramId: f.source.id, quantity: 3, variety: 35, softPreferences: 'new draft concept' } });
			const revised = await f.repository.getSchedulingCatalog(await f.repository.listPrograms(), [sequence.id]);
			expect(revised.semantic!.vectors).toBe(catalog.semantic!.vectors);
			expect(revised.semantic!.preferences?.['new draft concept']?.status).toBe('pending');
			expect(corpusReads).toHaveBeenCalledTimes(1);
			expect(preferenceReads).toHaveBeenCalledTimes(2);
		}
		finally {
			corpusReads.mockRestore();
			preferenceReads.mockRestore();
		}
	}
	finally {
		await f.close();
	}
});
