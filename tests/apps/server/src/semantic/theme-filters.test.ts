import { expect, it } from 'vitest';
import { themeProgramConfigSchema } from '@moirai/shared';
import { selectProgram } from '@server/scheduling/selection.js';
import { similarityProgramStatus } from '@server/semantic/status.js';
import { fixture, vector } from './fixtures.js';

it('filters theme previews and new sets while retaining committed sets across filter edits', async () => {
	const f = await fixture();
	try {
		await f.embeddings();
		const config = themeProgramConfigSchema.parse({ type: 'theme', libraryId: f.library.id,
			theme: 'Raunchy late-night comedies', quantity: 8, filter: { genres: ['Comedy'], excludedGenres: ['Horror'], releaseYearFrom: 2000 } });
		const program = await f.repository.createProgram({ name: 'Late-night comedies', config });
		f.semantic.preferences.catalog([config.theme]);
		for (const job of f.semantic.preferences.pending()) {
			f.semantic.preferences.store(job.hash, vector());
		}
		f.repository.invalidateSchedulingCatalog();
		const context = await f.context();
		const media = context.catalog.media;
		media.forEach((item, index) => {
			item.genres = index < 4 ? ['comedy'] : ['thriller'];
			item.year = 2010;
		});
		media[2]!.genres.push('horror');
		media[3]!.year = 1990;
		const expected = media.slice(0, 2).map((item) => item.id).sort();
		const preview = similarityProgramStatus(program, [...context.programs.values()], context.catalog);
		expect(preview.matchingItemCount).toBe(2);
		expect(preview.previewItems.map((item) => item.id).sort()).toEqual(expected);
		const selection = selectProgram(program.id, f.key, new Map(), context)!;
		const state = selection.state.get(f.key)!;
		expect(state.value.type).toBe('similarity');
		if (state.value.type !== 'similarity') {
			throw new Error('Expected a semantic set');
		}
		expect([...state.value.seed.itemIds].sort()).toEqual(expected);
		f.commit([...selection.state.values()]);

		await f.repository.updateProgram(program.id, { config: { ...config, filter: { ...config.filter!, genres: ['thriller'] } } });
		f.reopen();
		const next = await f.context();
		const saved = next.programs.get(program.id)!;
		expect(saved.config).toMatchObject({ filter: { genres: ['thriller'], excludedGenres: ['horror'], releaseYearFrom: 2000 } });
		const continued = selectProgram(program.id, f.key, new Map([[f.key, state]]), next)!;
		expect(continued.media.id).toBe(expected.find((id) => id !== selection.media.id));
	}
	finally {
		await f.close();
	}
});

it('keeps legacy themes unfiltered and rejects contradictory genre requirements', () => {
	const config = { type: 'theme', libraryId: '00000000-0000-4000-8000-000000000001', theme: 'Comedy' };
	expect(themeProgramConfigSchema.parse(config).filter).toBeUndefined();
	expect(themeProgramConfigSchema.safeParse({ ...config, filter: { genres: ['Comedy'], excludedGenres: ['comedy'] } }).success).toBe(false);
});

it('returns no theme matches when metadata filters exclude every candidate', async () => {
	const f = await fixture();
	try {
		await f.embeddings();
		const config = themeProgramConfigSchema.parse({ type: 'theme', libraryId: f.library.id, theme: 'Comedy', filter: { genres: ['comedy'] } });
		const program = await f.repository.createProgram({ name: 'Comedies only', config });
		f.semantic.preferences.catalog([config.theme]);
		for (const job of f.semantic.preferences.pending()) {
			f.semantic.preferences.store(job.hash, vector());
		}
		f.repository.invalidateSchedulingCatalog();
		const context = await f.context();
		expect(similarityProgramStatus(program, [...context.programs.values()], context.catalog)).toMatchObject({ health: 'empty', matchingItemCount: 0, previewItems: [] });
		expect(selectProgram(program.id, f.key, new Map(), context)).toBeNull();
	}
	finally {
		await f.close();
	}
});
