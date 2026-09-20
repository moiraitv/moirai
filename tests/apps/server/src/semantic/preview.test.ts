import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { validatorCompiler } from 'fastify-type-provider-zod';
import { expect, it } from 'vitest';
import { PROGRAM_PREVIEW_ITEM_LIMIT } from '@moirai/shared';
import { schedulingProgramStatuses } from '@server/scheduling/status.js';
import { registerSemanticProgramRoutes } from '@server/routes/semantic-programs.js';
import { responseSerializerCompiler } from '@server/routes/contracts.js';
import { fixture } from './fixtures.js';
import { selectProgram } from '@server/scheduling/selection.js';
import { publicError } from '@server/routes/public-errors.js';

it('returns cached source-excluding samples without creating seeds or consumption', async () => {
	const f = await fixture();
	try {
		await f.embeddings();
		const { catalog, programs } = await f.context();
		const statuses = () => schedulingProgramStatuses([...programs.values()], catalog);
		const sample = statuses().find((status) => status.programId === f.program.id)!;
		expect(sample.previewItems).toHaveLength(3);
		expect(sample.matchingItemCount).toBe(f.ids.length - 1);
		expect(sample.requestedItemCount).toBe(3);
		expect(sample.previewItems.map((item) => item.id)).not.toContain(f.ids[0]);
		expect(statuses().find((status) => status.programId === f.program.id)!.previewItems).toBe(sample.previewItems);
		const program = programs.get(f.program.id)!;
		if (program.config.type !== 'similarity') {
			throw new Error('Expected Similar Items');
		}
		program.config.quantity = 500;
		for (let index = 0; index < PROGRAM_PREVIEW_ITEM_LIMIT; index += 1) {
			const id = randomUUID();
			catalog.media.push({ ...catalog.media[0]!, id });
			catalog.semantic!.vectors[id] = catalog.semantic!.vectors[f.ids[0]!]!;
		}
		const expanded = statuses().find((status) => status.programId === program.id)!;
		expect(expanded.previewItems).toHaveLength(PROGRAM_PREVIEW_ITEM_LIMIT);
		expect(expanded.matchingItemCount).toBe(f.ids.length - 1 + PROGRAM_PREVIEW_ITEM_LIMIT);
		expect(expanded.requestedItemCount).toBe(500);
		expect(f.semantic.seeds()).toEqual([]);
		expect(await f.repository.getSelectionState(f.channel.id)).toEqual([]);
	}
	finally {
		await f.close();
	}
});

it('previews unsaved settings through HTTP and validates source compatibility and limits', async () => {
	const f = await fixture();
	const app = Fastify();
	app.setErrorHandler((error, request, reply) => {
		const mapped = publicError(error, request.id);
		reply.status(mapped.statusCode).send(mapped.body);
	});
	app.setValidatorCompiler(validatorCompiler);
	app.setSerializerCompiler(responseSerializerCompiler);
	await app.register(sensible);
	registerSemanticProgramRoutes(app, f.repository);
	try {
		await f.embeddings();
		const config = { type: 'similarity', sourceProgramId: f.source.id, quantity: 2, variety: 80 };
		const response = await app.inject({ method: 'POST', url: '/api/v1/programs/similarity-preview', payload: config });
		expect(response.statusCode).toBe(200);
		expect(response.json().previewItems).toHaveLength(2);
		const incompatible = await app.inject({ method: 'POST', url: '/api/v1/programs/similarity-preview', payload: { ...config, sourceProgramId: f.program.id } });
		expect(incompatible.statusCode).toBe(400);
		const invalidQuantity = await app.inject({ method: 'POST', url: '/api/v1/programs/similarity-preview', payload: { ...config, quantity: 501 } });
		expect(invalidQuantity.statusCode).toBe(400);
		expect(f.semantic.seeds()).toEqual([]);
		expect(await f.repository.listPrograms()).toHaveLength(2);
	}
	finally {
		await app.close();
		await f.close();
	}
});

it('distinguishes preparing refinements from empty samples and inference failures', async () => {
	const f = await fixture();
	try {
		if (f.program.config.type !== 'similarity') {
			throw new Error('Expected Similar Items fixture');
		}
		await f.embeddings();
		await f.repository.updateProgram(f.program.id, { config: { ...f.program.config, hardExclusions: ['superhero movies'] } });
		const { catalog, programs } = await f.context();
		const status = () => schedulingProgramStatuses([...programs.values()], catalog).find((entry) => entry.programId === f.program.id)!;
		expect(status()).toMatchObject({ previewPending: true, previewItems: [] });
		catalog.semantic!.preferences!['superhero movies'] = { status: 'failed' };
		expect(status().previewPending).toBe(false);
		catalog.semantic!.preferences!['superhero movies'] = { status: 'pending', error: 'Model unavailable' };
		expect(status().previewPending).toBe(false);
		catalog.semantic!.preferences!['superhero movies'] = { status: 'ready', vector: catalog.semantic!.vectors[f.ids[0]!]! };
		expect(status()).toMatchObject({ previewPending: false, previewItems: [] });
	}
	finally {
		await f.close();
	}
});

it('reports the original requested count for a short active set after settings change', async () => {
	const f = await fixture();
	try {
		await f.embeddings();
		await f.repository.updateProgram(f.program.id, { config: { type: 'similarity', sourceProgramId: f.source.id, variety: 35, quantity: 20 } });
		const selected = selectProgram(f.program.id, f.key, new Map(), await f.context())!;
		f.commit([...selected.state.values()]);
		await f.repository.updateProgram(f.program.id, { config: { type: 'similarity', sourceProgramId: f.source.id, variety: 35, quantity: 2 } });
		const { programs, catalog } = await f.context();
		const status = schedulingProgramStatuses([...programs.values()], catalog).find((entry) => entry.programId === f.program.id)!;
		expect(status.requestedItemCount).toBe(2);
		expect(status.currentSets?.[0]).toMatchObject({ total: f.ids.length - 1, requestedTotal: 20, remaining: f.ids.length - 2 });
	}
	finally {
		await f.close();
	}
});
