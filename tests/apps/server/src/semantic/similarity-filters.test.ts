import { expect, it } from 'vitest';
import { similarityProgramConfigSchema } from '@moirai/shared';
import { semanticSource } from '@server/semantic/source.js';
import { similarityProgramStatus } from '@server/semantic/status.js';
import { selectProgram } from '@server/scheduling/selection.js';
import { fixture } from './fixtures.js';

it('filters candidates without filtering anchors and preserves saved filters across restart', async () => {
	const f = await fixture();
	try {
		await f.embeddings();
		const config = similarityProgramConfigSchema.parse({ ...f.program.config,
			filter: { genres: ['Comedy'], excludedGenres: ['Horror'], releaseYearFrom: 1980, releaseYearTo: 1989, minimumDurationSeconds: 60, maximumDurationSeconds: 120 } });
		await f.repository.updateProgram(f.program.id, { config });
		f.reopen();
		const context = await f.context();
		const program = context.programs.get(f.program.id)!;
		expect(program.config).toMatchObject({ filter: { genres: ['comedy'], excludedGenres: ['horror'], releaseYearFrom: 1980, releaseYearTo: 1989, minimumDurationSeconds: 60, maximumDurationSeconds: 120 } });
		const candidates = context.catalog.media.filter((item) => item.id !== f.ids[0]);
		for (const item of context.catalog.media) {
			item.genres = ['drama'];
			item.year = 2000;
		}
		for (const item of candidates.slice(0, 3)) {
			item.genres = ['comedy'];
			item.year = 1985;
			item.durationSeconds = 90;
		}
		candidates[1]!.genres.push('horror');
		candidates[2]!.durationSeconds = 120.001;
		const source = semanticSource(config, [...context.programs.values()], context.catalog);
		expect(source.sourceIds).toEqual([f.ids[0]]);
		expect(source.anchors).toHaveLength(1);
		expect(source.items.map((item) => item.id)).toEqual([candidates[0]!.id]);
		const preview = similarityProgramStatus(program, [...context.programs.values()], context.catalog);
		expect(preview.matchingItemCount).toBe(1);
		expect(preview.previewItems.map((item) => item.id)).toEqual([candidates[0]!.id]);
		const selection = selectProgram(program.id, f.key, new Map(), context)!;
		expect(selection.media.id).toBe(candidates[0]!.id);
		expect(selection.state.get(f.key)!.value).toMatchObject({ seed: { sourceItemIds: [f.ids[0]], itemIds: [candidates[0]!.id] } });

		const impossible = { ...program, config: { ...config, filter: { ...config.filter!, genres: ['documentary'] } } };
		context.programs.set(program.id, impossible);
		expect(similarityProgramStatus(impossible, [...context.programs.values()], context.catalog)).toMatchObject({ matchingItemCount: 0, previewItems: [] });
		expect(selectProgram(program.id, f.key, new Map(), context)).toBeNull();
	}
	finally {
		await f.close();
	}
});

it('keeps legacy similarity programs unfiltered and rejects conflicting genre rules', () => {
	const config = { type: 'similarity', sourceProgramId: '00000000-0000-4000-8000-000000000001' };
	expect(similarityProgramConfigSchema.parse(config).filter).toBeUndefined();
	expect(similarityProgramConfigSchema.safeParse({ ...config, filter: { genres: ['Comedy'], excludedGenres: ['comedy'] } }).success).toBe(false);
});
