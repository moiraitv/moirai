import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { validatorCompiler } from 'fastify-type-provider-zod';
import { expect, it, vi } from 'vitest';
import { registerSemanticProgramRoutes } from '@server/routes/semantic-programs.js';
import { publicError } from '@server/routes/public-errors.js';
import { responseSerializerCompiler } from '@server/routes/contracts.js';
import { selectProgram } from '@server/scheduling/selection.js';
import { fixture, vector } from './fixtures.js';

it('retries failed relevant media and draft concepts once while preserving unrelated failures, ready vectors and seeds', async () => {
	const f = await fixture();
	const app = Fastify();
	app.setErrorHandler((error, request, reply) => {
		const mapped = publicError(error, request.id);
		reply.status(mapped.statusCode).send(mapped.body);
	});
	app.setValidatorCompiler(validatorCompiler);
	app.setSerializerCompiler(responseSerializerCompiler);
	await app.register(sensible);
	const wake = vi.fn();
	registerSemanticProgramRoutes(app, f.repository, wake);
	try {
		await f.embeddings();
		const first = selectProgram(f.program.id, f.key, new Map(), await f.context())!;
		f.commit([...first.state.values()]);
		const seeds = f.semantic.seeds();
		const ready = f.semantic.catalog().vectors[f.ids[0]!]!;
		f.database.sqlite.prepare("UPDATE media_embeddings SET status='failed',embedding=NULL WHERE media_id IN (?,?)").run(f.ids[1], f.ids[2]);
		f.database.sqlite.prepare("UPDATE media_items SET kind='music' WHERE id=?").run(f.ids[2]);
		f.semantic.preferences.catalog(['superhero movies', 'unrelated concept', 'space']);
		for (const entry of f.semantic.preferences.pending()) {
			f.semantic.preferences.store(entry.hash, entry.text === 'space' ? vector() : null);
		}
		f.repository.invalidateSchedulingCatalog();
		const config = { type: 'similarity', sourceProgramId: f.source.id, hardExclusions: ['superhero movies'], softPreferences: 'space' };
		const response = await app.inject({ method: 'POST', url: '/api/v1/programs/similarity-retry', payload: config });
		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual({ queued: 2 });
		expect(wake).toHaveBeenCalledWith(true);
		expect((await app.inject({ method: 'POST', url: '/api/v1/programs/similarity-retry', payload: config })).json()).toEqual({ queued: 0 });
		expect(wake).toHaveBeenCalledTimes(1);
		expect(f.semantic.catalog().vectors[f.ids[0]!]).toEqual(ready);
		expect(f.semantic.seeds()).toEqual(seeds);
		expect(await f.repository.getSelectionState(f.channel.id)).toEqual([...first.state.values()]);
		expect(f.semantic.preferences.catalog(['unrelated concept'])['unrelated concept']?.status).toBe('failed');
		expect(f.database.sqlite.prepare('SELECT status FROM media_embeddings WHERE media_id=?').get(f.ids[2])).toEqual({ status: 'failed' });
		const retry = f.semantic.reconcile().find((input) => input.id === f.ids[1])!;
		f.semantic.store(retry, null);
		expect(f.semantic.reconcile().some((input) => input.id === f.ids[1])).toBe(false);
		const invalid = await app.inject({ method: 'POST', url: '/api/v1/programs/similarity-retry', payload: { ...config, sourceProgramId: f.program.id } });
		expect(invalid.statusCode).toBe(400);
	}
	finally {
		await app.close();
		await f.close();
	}
});
