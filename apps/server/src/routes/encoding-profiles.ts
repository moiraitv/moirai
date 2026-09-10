import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { encodingProfileCreateSchema, encodingProfileSchema } from '@moirai/shared';
import type { Repository } from '../repository/index.js';
import type { LiveEventHub } from '../operations/live-events.js';
import { apiOperation, emptyResponseSchema, idParamsSchema, responseContent } from './contracts.js';
import { parseId } from './params.js';

/** Register authenticated encoding-profile administration using the shared wire contracts. */
export function registerEncodingProfileRoutes(app: FastifyInstance, dependencies: { repository: Repository; events: LiveEventHub }): void {
	const { repository, events } = dependencies;
	app.get('/api/v1/encoding-profiles', { schema: apiOperation({
		operationId: 'listEncodingProfiles', tags: ['Encoding profiles'], summary: 'List reusable audio and video settings',
		response: { 200: responseContent('Encoding profiles', 'application/json', z.array(encodingProfileSchema)) }, errors: [500, 503],
	}) }, async () => repository.encodingProfiles.list());

	app.put('/api/v1/encoding-profiles/:id/default', { schema: apiOperation({
		operationId: 'setDefaultEncodingProfile', tags: ['Encoding profiles'], summary: 'Choose the encoding profile for new channels', params: idParamsSchema,
		response: { 200: responseContent('Default encoding profile', 'application/json', encodingProfileSchema) }, errors: [400, 404, 500, 503],
	}) }, async (request) => repository.encodingProfiles.setDefault(parseId(request)));

	for (const update of [false, true]) {
		app.route({ method: update ? 'PUT' : 'POST', url: update ? '/api/v1/encoding-profiles/:id' : '/api/v1/encoding-profiles',
			schema: apiOperation({ operationId: update ? 'updateEncodingProfile' : 'createEncodingProfile', tags: ['Encoding profiles'],
				summary: update ? 'Replace encoding settings and update linked channels' : 'Create an encoding profile',
				...(update ? { params: idParamsSchema } : {}), body: encodingProfileCreateSchema,
				response: { [update ? 200 : 201]: responseContent('Encoding profile', 'application/json', encodingProfileSchema) }, errors: [400, 404, 409, 500, 503],
			}), handler: async (request, reply) => {
				const result = await repository.encodingProfiles.save(encodingProfileCreateSchema.parse(request.body), update ? parseId(request) : undefined);
				for (const id of result.channelIds) {
					events.publish({ type: 'channel.changed', data: { channelId: id, change: 'updated' } });
				}
				return reply.status(update ? 200 : 201).send(result.profile);
			},
		});
	}
	app.delete('/api/v1/encoding-profiles/:id', { schema: apiOperation({
		operationId: 'deleteEncodingProfile', tags: ['Encoding profiles'], summary: 'Delete an unused encoding profile', params: idParamsSchema,
		response: { 204: responseContent('Deleted', 'application/json', emptyResponseSchema) }, errors: [400, 404, 409, 500, 503],
	}) }, async (request, reply) => {
		await repository.encodingProfiles.delete(parseId(request));
		return reply.status(204).send();
	});
}
