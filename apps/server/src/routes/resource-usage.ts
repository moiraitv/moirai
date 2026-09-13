import type { FastifyInstance } from 'fastify';
import { mediaAiringsResponseSchema, resourceUsageParamsSchema, resourceUsageQuerySchema, resourceUsageResponseSchema } from '@moirai/shared';
import type { Repository } from '../repository/index.js';
import { apiOperation, responseContent } from './contracts.js';

/** Register authenticated on-demand inspection of resource references and realized media showings. */
export function registerResourceUsageRoutes(app: FastifyInstance, { repository }: { repository: Repository }): void {
	app.get('/api/v1/resource-usage/:kind/:id', { schema: apiOperation({
		operationId: 'getResourceUsage', tags: ['Scheduling'], summary: 'List resource references and current media membership',
		params: resourceUsageParamsSchema, querystring: resourceUsageQuerySchema,
		response: { 200: responseContent('Direct references', 'application/json', resourceUsageResponseSchema) }, errors: [400, 404, 500, 503],
	}) }, async (request, reply) => {
		const { kind, id } = resourceUsageParamsSchema.parse(request.params);
		const { page, pageSize } = resourceUsageQuerySchema.parse(request.query);
		const result = await repository.resourceUsage(kind, id, page, pageSize);
		return result ?? reply.status(404).send({ code: 'not_found', message: 'Resource not found', requestId: request.id });
	});
	app.get('/api/v1/media/:id/airings', { schema: apiOperation({
		operationId: 'getMediaAirings', tags: ['Scheduling'], summary: 'List current and upcoming committed showings of a media item',
		params: resourceUsageParamsSchema.pick({ id: true }), querystring: resourceUsageQuerySchema,
		response: { 200: responseContent('Realized showings', 'application/json', mediaAiringsResponseSchema) }, errors: [400, 404, 500, 503],
	}) }, async (request, reply) => {
		const { id } = resourceUsageParamsSchema.pick({ id: true }).parse(request.params);
		const { page, pageSize } = resourceUsageQuerySchema.parse(request.query);
		const result = repository.mediaAirings(id, page, pageSize);
		return result ?? reply.status(404).send({ code: 'not_found', message: 'Media item not found', requestId: request.id });
	});
}
