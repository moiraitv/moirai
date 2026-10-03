import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { midRollPresetCreateSchema, midRollPresetSchema } from '@moirai/shared';
import type { Repository } from '../repository/index.js';
import type { LiveEventHub } from '../operations/live-events.js';
import { apiOperation, emptyResponseSchema, idParamsSchema, responseContent } from './contracts.js';
import { parseId } from './params.js';

/** Register authenticated reusable mid-roll behavior administration. */
export function registerMidRollPresetRoutes(app: FastifyInstance, dependencies: { repository: Repository; events: LiveEventHub }): void {
	const { repository, events } = dependencies;
	app.get('/api/v1/mid-roll-presets', { schema: apiOperation({
		operationId: 'listMidRollPresets', tags: ['Mid-Rolls'], summary: 'List reusable break settings',
		response: { 200: responseContent('Mid-Rolls', 'application/json', z.array(midRollPresetSchema)) }, errors: [500, 503],
	}) }, async () => repository.midRollPresets.list());

	for (const update of [false, true]) {
		app.route({ method: update ? 'PUT' : 'POST', url: update ? '/api/v1/mid-roll-presets/:id' : '/api/v1/mid-roll-presets',
			schema: apiOperation({ operationId: update ? 'updateMidRollPreset' : 'createMidRollPreset', tags: ['Mid-Rolls'],
				summary: update ? 'Replace reusable break settings' : 'Create a Mid-Roll',
				...(update ? { params: idParamsSchema } : {}), body: midRollPresetCreateSchema,
				response: { [update ? 200 : 201]: responseContent('Mid-roll preset', 'application/json', midRollPresetSchema) }, errors: [400, 404, 409, 500, 503],
			}), handler: async (request, reply) => {
				const result = await repository.midRollPresets.save(midRollPresetCreateSchema.parse(request.body), update ? parseId(request) : undefined);
				if (!update || result.behaviorChanged) {
					events.publish({ type: 'scheduling.changed', data: { entity: 'mid-roll-preset', change: update ? 'updated' : 'created', id: result.preset.id } });
				}
				return reply.status(update ? 200 : 201).send(result.preset);
			},
		});
	}
	app.delete('/api/v1/mid-roll-presets/:id', { schema: apiOperation({
		operationId: 'deleteMidRollPreset', tags: ['Mid-Rolls'], summary: 'Delete an unused custom Mid-Roll', params: idParamsSchema,
		response: { 204: responseContent('Deleted', 'application/json', emptyResponseSchema) }, errors: [400, 404, 409, 500, 503],
	}) }, async (request, reply) => {
		await repository.midRollPresets.delete(parseId(request));
		events.publish({ type: 'scheduling.changed', data: { entity: 'mid-roll-preset', change: 'deleted', id: parseId(request) } });
		return reply.status(204).send();
	});
}
