import type { FastifyInstance } from 'fastify';
import { Temporal } from '@js-temporal/polyfill';
import { z } from 'zod';
import {
	guideTemplateCreateSchema,
	guideTemplatePreviewResultSchema,
	guideTemplatePreviewSchema,
	guideTemplateSchema,
} from '@moirai/shared';
import type { AppConfig } from '../config.js';
import { previewGuideListings } from '../guide/epg.js';
import {
	CommittedGuideRangeError,
	CommittedGuideUnavailableError,
	GuideMaterializationLimitError,
	readCommittedGuideAfterMaterializing,
	readCommittedScheduleGuide,
} from '../guide/schedule-guide.js';
import type { LiveEventHub } from '../operations/live-events.js';
import type { Repository } from '../repository/index.js';
import type { TimelineMaterializer } from '../scheduling/timeline-materializer.js';
import { validateGuideTemplateSources } from '../guide/xmltv-template.js';
import { apiOperation, emptyResponseSchema, idParamsSchema, responseContent } from './contracts.js';
import { parseId } from './params.js';

/** Register authenticated XMLTV template administration, default selection, and preview. */
export function registerGuideTemplateRoutes(app: FastifyInstance, dependencies: {
	config: AppConfig;
	repository: Repository;
	events: LiveEventHub;
	timelineMaterializer: TimelineMaterializer;
}): void {
	const { config, repository, events, timelineMaterializer } = dependencies;

	app.get('/api/v1/guide-templates', { schema: apiOperation({
		operationId: 'listGuideTemplates', tags: ['Guide templates'], summary: 'List reusable XMLTV templates',
		response: { 200: responseContent('Guide templates', 'application/json', z.array(guideTemplateSchema)) }, errors: [500, 503],
	}) }, async () => repository.guideTemplates.list());

	app.put('/api/v1/guide-templates/:id/default', { schema: apiOperation({
		operationId: 'setDefaultGuideTemplate', tags: ['Guide templates'],
		summary: 'Choose the XMLTV template used when a channel does not assign one',
		params: idParamsSchema,
		response: { 200: responseContent('Default guide template', 'application/json', guideTemplateSchema) }, errors: [400, 404, 500, 503],
	}) }, async (request) => {
		const result = await repository.guideTemplates.setDefault(parseId(request));
		events.publish({ type: 'scheduling.changed', data: { entity: 'guide-template', change: 'updated', id: result.id } });
		return result;
	});

	for (const update of [false, true]) {
		app.route({
			method: update ? 'PUT' : 'POST',
			url: update ? '/api/v1/guide-templates/:id' : '/api/v1/guide-templates',
			schema: apiOperation({
				operationId: update ? 'updateGuideTemplate' : 'createGuideTemplate',
				tags: ['Guide templates'],
				summary: update ? 'Replace an XMLTV template' : 'Create an XMLTV template',
				...(update ? { params: idParamsSchema } : {}),
				body: guideTemplateCreateSchema,
				response: { [update ? 200 : 201]: responseContent('Guide template', 'application/json', guideTemplateSchema) },
				errors: [400, 404, 409, 500, 503],
			}),
			handler: async (request, reply) => {
				const input = guideTemplateCreateSchema.parse(request.body);
				try {
					await validateGuideTemplateSources(input.sources);
				}
				catch (cause) {
					throw app.httpErrors.badRequest(cause instanceof Error ? cause.message : 'Invalid guide template');
				}
				const result = await repository.guideTemplates.save(input, update ? parseId(request) : undefined);
				events.publish({
					type: 'scheduling.changed',
					data: { entity: 'guide-template', change: update ? 'updated' : 'created', id: result.id },
				});
				return reply.status(update ? 200 : 201).send(result);
			},
		});
	}

	app.delete('/api/v1/guide-templates/:id', { schema: apiOperation({
		operationId: 'deleteGuideTemplate', tags: ['Guide templates'], summary: 'Delete an unreferenced XMLTV template',
		params: idParamsSchema, response: { 204: responseContent('Deleted', 'application/json', emptyResponseSchema) }, errors: [400, 404, 409, 500, 503],
	}) }, async (request, reply) => {
		const id = parseId(request);
		await repository.guideTemplates.delete(id);
		events.publish({ type: 'scheduling.changed', data: { entity: 'guide-template', change: 'deleted', id } });
		return reply.status(204).send();
	});

	app.post('/api/v1/guide-templates/preview', { schema: apiOperation({
		operationId: 'previewGuideTemplate', tags: ['Guide templates'],
		summary: 'Preview draft XMLTV sources as one channel day',
		body: guideTemplatePreviewSchema,
		response: { 200: responseContent('Guide template preview', 'application/json', guideTemplatePreviewResultSchema) },
		errors: [400, 404, 422, 500, 503],
	}) }, async (request, reply) => {
		const input = guideTemplatePreviewSchema.parse(request.body);
		try {
			await validateGuideTemplateSources(input.sources);
		}
		catch (cause) {
			throw app.httpErrors.badRequest(cause instanceof Error ? cause.message : 'Invalid guide template');
		}

		const channel = await repository.getChannel(input.channelId);
		if (!channel) {
			throw app.httpErrors.notFound('Channel not found');
		}

		const startDate = Temporal.Now.plainDateISO(config.timeZone).toString();
		try {
			const materialized = await readCommittedGuideAfterMaterializing(
				() => readCommittedScheduleGuide(
					repository,
					config.timeZone,
					startDate,
					1,
					{ includeMediaCatalog: true },
				),
				() => timelineMaterializer.runNow(),
			);
			const preview = await previewGuideListings(
				channel,
				materialized.guide,
				materialized.catalog,
				config.publicUrl,
				input.sources,
			);
			return {
				timeZone: materialized.guide.timeZone,
				startDate: materialized.guide.startDate,
				...preview,
			};
		}
		catch (error) {
			if (
				error instanceof GuideMaterializationLimitError
				|| error instanceof CommittedGuideRangeError
			) {
				throw app.httpErrors.unprocessableEntity(error.message);
			}
			if (error instanceof CommittedGuideUnavailableError) {
				reply.header('Retry-After', '5');
				throw app.httpErrors.serviceUnavailable(error.message);
			}
			throw app.httpErrors.badRequest(error instanceof Error ? error.message : 'Unable to preview guide template');
		}
	});
}
