import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { anyFillerPresetCreateSchema, anyFillerPresetSchema, fillerKindSchema } from '@moirai/shared';
import type { Repository } from '../repository/index.js';
import type { LiveEventHub } from '../operations/live-events.js';
import { apiOperation, emptyResponseSchema, idParamsSchema, responseContent } from './contracts.js';
import { parseId } from './params.js';

/** Register authenticated, typed filler preset administration. */
export function registerFillerPresetRoutes(app: FastifyInstance, dependencies: { repository: Repository; events: LiveEventHub }): void {
	const { repository, events } = dependencies;
	app.get('/api/v1/filler-presets', { schema: apiOperation({
		operationId: 'listFillerPresets', tags: ['Filler'], summary: 'List reusable filler settings', querystring: z.object({ kind: fillerKindSchema.optional() }),
		response: { 200: responseContent('Filler', 'application/json', z.array(anyFillerPresetSchema)) }, errors: [500, 503],
	}) }, async request => repository.fillerPresets.list(z.object({ kind: fillerKindSchema.optional() }).parse(request.query).kind));

	for (const update of [false, true]) {
		app.route({ method: update ? 'PUT' : 'POST', url: update ? '/api/v1/filler-presets/:id' : '/api/v1/filler-presets',
			schema: apiOperation({ operationId: update ? 'updateFillerPreset' : 'createFillerPreset', tags: ['Filler'],
				summary: update ? 'Replace reusable break settings' : 'Create a filler preset',
				...(update ? { params: idParamsSchema } : {}), body: anyFillerPresetCreateSchema,
				response: { [update ? 200 : 201]: responseContent('Mid-roll preset', 'application/json', anyFillerPresetSchema) }, errors: [400, 404, 409, 500, 503],
			}), handler: async (request, reply) => {
				const result = await repository.fillerPresets.save(anyFillerPresetCreateSchema.parse(request.body), update ? parseId(request) : undefined);
				if (!update || result.behaviorChanged) {
					events.publish({ type: 'scheduling.changed', data: { entity: 'filler-preset', change: update ? 'updated' : 'created', id: result.preset.id } });
				}
				return reply.status(update ? 200 : 201).send(result.preset);
			},
		});
	}
	app.delete('/api/v1/filler-presets/:id', { schema: apiOperation({
		operationId: 'deleteFillerPreset', tags: ['Filler'], summary: 'Delete an unused custom filler preset', params: idParamsSchema,
		response: { 204: responseContent('Deleted', 'application/json', emptyResponseSchema) }, errors: [400, 404, 409, 500, 503],
	}) }, async (request, reply) => {
		await repository.fillerPresets.delete(parseId(request));
		events.publish({ type: 'scheduling.changed', data: { entity: 'filler-preset', change: 'deleted', id: parseId(request) } });
		return reply.status(204).send();
	});
}
