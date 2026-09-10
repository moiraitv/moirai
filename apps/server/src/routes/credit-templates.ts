import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { creditTemplateCreateSchema, creditTemplateSchema, creditPreviewSchema, creditPreviewResultSchema } from '@moirai/shared';
import type { Repository } from '../repository/index.js';
import type { PlayoutSynchronizer } from '../playback/playout-synchronizer.js';
import type { LiveEventHub } from '../operations/live-events.js';
import { previewCredits } from '../playback/credit-preview.js';
import { CreditRendererBusyError, renderCreditTemplate } from '../playback/credit-renderer.js';
import { apiOperation, emptyResponseSchema, idParamsSchema, responseContent } from './contracts.js';
import { parseId } from './params.js';

/** Safe representative context used to reject invalid authored templates before persistence. */
const validationContext = {
	resolution: { width: 1920, height: 1080 }, title: 'Title', artist: 'Artist', all_artists: ['Artist'],
	album: 'Album', track: 1, plot: '', release_date: { year: 2026, date: '2026-01-01' },
	studios: ['Studio'], directors: ['Director'], duration: { total_seconds: 180 },
};

/** Register authenticated reusable-template administration, preview, and playback diagnostics. */
export function registerCreditTemplateRoutes(app: FastifyInstance, dependencies: {
	repository: Repository; playout: PlayoutSynchronizer; events: LiveEventHub;
}): void {
	const { repository, playout, events } = dependencies;
	app.get('/api/v1/credit-templates', { schema: apiOperation({
		operationId: 'listCreditTemplates', tags: ['Credit templates'], summary: 'List music-video credit templates',
		response: { 200: responseContent('Credit templates', 'application/json', z.array(creditTemplateSchema)) }, errors: [500, 503],
	}) }, async () => repository.creditTemplates.list());

	for (const update of [false, true]) {
		app.route({
			method: update ? 'PUT' : 'POST', url: update ? '/api/v1/credit-templates/:id' : '/api/v1/credit-templates',
			schema: apiOperation({ operationId: update ? 'updateCreditTemplate' : 'createCreditTemplate', tags: ['Credit templates'],
				summary: update ? 'Replace a music-video credit template' : 'Create a music-video credit template',
				...(update ? { params: idParamsSchema } : {}), body: creditTemplateCreateSchema,
				response: { [update ? 200 : 201]: responseContent('Credit template', 'application/json', creditTemplateSchema) }, errors: [400, 404, 409, 500, 503],
			}),
			handler: async (request, reply) => {
				const input = creditTemplateCreateSchema.parse(request.body);
				try {
					await renderCreditTemplate(input.source, validationContext);
				}
				catch (cause) {
					if (cause instanceof CreditRendererBusyError) {
						throw app.httpErrors.serviceUnavailable(cause.message);
					}
					throw app.httpErrors.badRequest(cause instanceof Error ? cause.message : 'Invalid credit template');
				}
				const result = await repository.creditTemplates.save(input, update ? parseId(request) : undefined);
				events.publish({ type: 'scheduling.changed', data: { entity: 'credit-template', change: update ? 'updated' : 'created', id: result.id } });
				return reply.status(update ? 200 : 201).send(result);
			},
		});
	}
	app.delete('/api/v1/credit-templates/:id', { schema: apiOperation({
		operationId: 'deleteCreditTemplate', tags: ['Credit templates'], summary: 'Delete an unreferenced credit template',
		params: idParamsSchema, response: { 204: responseContent('Deleted', 'application/json', emptyResponseSchema) }, errors: [400, 404, 409, 500, 503],
	}) }, async (request, reply) => {
		await repository.creditTemplates.delete(parseId(request));
		return reply.status(204).send();
	});
	app.post('/api/v1/credit-templates/preview', { schema: apiOperation({
		operationId: 'previewCreditTemplate', tags: ['Credit templates'], summary: 'Preview draft credits on a music video',
		body: creditPreviewSchema, response: { 200: responseContent('Rendered credits', 'application/json', creditPreviewResultSchema) }, errors: [400, 404, 500, 503],
	}) }, async (request) => {
		const input = creditPreviewSchema.parse(request.body);
		const channel = await repository.getChannel(input.channelId);
		const item = (await repository.creditTemplates.media([input.mediaItemId])).get(input.mediaItemId);
		if (!channel || !item) {
			throw app.httpErrors.notFound('Channel or media item not found');
		}
		try {
			return await previewCredits(input.source, item, channel, input.seconds);
		}
		catch (cause) {
			if (cause instanceof CreditRendererBusyError) {
				throw app.httpErrors.serviceUnavailable(cause.message);
			}
			throw app.httpErrors.badRequest(cause instanceof Error ? cause.message : 'Unable to preview credits');
		}
	});
	app.get('/api/v1/channels/:id/subtitle-issues', { schema: apiOperation({
		operationId: 'getChannelSubtitleIssues', tags: ['Channels'], summary: 'Read subtitle preparation issues', params: idParamsSchema,
		response: { 200: responseContent('Subtitle issues', 'application/json', z.array(z.string())) }, errors: [400, 404, 500, 503],
	}) }, async (request) => playout.subtitles.issues.get(parseId(request)) ?? []);
}
