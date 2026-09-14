import { registerProgramGroupRoutes } from './program-groups.js';
import type { FastifyInstance } from 'fastify';
import { Temporal } from '@js-temporal/polyfill';
import { z } from 'zod';
import {
	channelScheduleConfigSchema,
	channelScheduleDraftPreviewSchema,
	MAX_TIMELINE_PREVIEW_DAYS,
	programItemAdditionSchema,
	type ProgramConfig,
	programCreateSchema,
	programUpdateSchema,
	scheduleTemplateCreateSchema,
	scheduleTemplateUpdateSchema,
	templateAssignmentsSchema,
	timelineDraftPreviewSchema,
} from '@moirai/shared';
import {
	apiErrorBodySchema,
	channelScheduleSchema,
	programItemAdditionConfirmationErrorSchema,
	scheduleTemplateSchema,
	schedulingOverviewSchema,
	programItemAdditionResultSchema,
	schedulingProgramSchema,
	timelinePreviewSchema,
} from '@moirai/shared/api-contracts';
import type { AppConfig } from '../config.js';
import type { LiveEventHub } from '../operations/live-events.js';
import type { Repository } from '../repository/index.js';
import { schedulingRootProgramIds } from '../scheduling/catalog.js';
import { schedulingProgramStatuses } from '../scheduling/status.js';
import { guideTimelinePreview } from '../guide/preview.js';
import { validateTemplate } from '../scheduling/validation.js';
import type { SchedulingWorkerPool } from '../scheduling/worker-pool.js';
import { currentTimestamp } from '../time.js';
import { parseId } from './params.js';
import { apiOperation, emptyResponseSchema, idParamsSchema, responseContent } from './contracts.js';

/** Synthetic channel identity used for channel-independent template previews. */
const DRAFT_PREVIEW_CHANNEL_ID = '00000000-0000-4000-8000-000000000001';

/** Bounded local-date window accepted by persisted timeline previews. */
const timelinePreviewQuerySchema = z.object({
	startDate: z.iso.date().optional(),
	days: z.coerce.number().int().min(1).max(MAX_TIMELINE_PREVIEW_DAYS).default(7),
});

/** Return the explicit item count when a program owns a concrete media collection. */
function explicitItemCount(config: ProgramConfig | undefined): number | null {
	return config?.type === 'content' && config.source.type === 'collection'
		? config.source.itemIds.length
		: null;
}

/** Services required by program, template, preview, and assignment routes. */
interface SchedulingRouteDependencies {
	config: AppConfig;
	repository: Repository;
	events: LiveEventHub;
	schedulingWorkers: SchedulingWorkerPool;
}

/** Register reusable scheduling configuration and preview endpoints. */
export function registerSchedulingRoutes(
	app: FastifyInstance,
	{ config, repository, events, schedulingWorkers }: SchedulingRouteDependencies,
): void {
	registerProgramGroupRoutes(app, repository, events);
	// Reusable program definitions.
	app.get('/api/v1/programs', {
		schema: apiOperation({
			operationId: 'listPrograms',
			tags: ['Programs'],
			summary: 'List reusable content programs',
			response: { 200: responseContent('Configured programs', 'application/json', z.array(schedulingProgramSchema)) },
			errors: [500, 503],
		}),
	}, async () => repository.listPrograms());
	app.post('/api/v1/programs', {
		schema: apiOperation({
			operationId: 'createProgram',
			tags: ['Programs'],
			summary: 'Create a content program',
			body: programCreateSchema,
			response: { 201: responseContent('Created program', 'application/json', schedulingProgramSchema) },
			errors: [400, 409, 500, 503],
		}),
	}, async (request, reply) => {
		const input = programCreateSchema.parse(request.body);
		const itemCount = explicitItemCount(input.config);
		if (itemCount !== null && itemCount > config.maxExplicitMediaItems) {
			throw app.httpErrors.conflict(
				`The program exceeds the configured ${config.maxExplicitMediaItems.toLocaleString()}-item limit`,
			);
		}

		const program = await repository.createProgram(input);
		events.publish({
			type: 'scheduling.changed',
			data: { entity: 'program', change: 'created', id: program.id },
		});
		return reply.status(201).send(program);
	});
	app.post('/api/v1/libraries/:id/program-items', {
		schema: apiOperation({
			operationId: 'addLibraryItemsToProgram',
			tags: ['Programs'],
			summary: 'Add library items to a selected-items program',
			params: idParamsSchema,
			body: programItemAdditionSchema,
			response: {
				200: responseContent('Updated selected-items program', 'application/json', programItemAdditionResultSchema),
				201: responseContent('Created selected-items program', 'application/json', programItemAdditionResultSchema),
				409: responseContent(
					'Program addition needs confirmation or conflicts with current state',
					'application/json',
					z.union([programItemAdditionConfirmationErrorSchema, apiErrorBodySchema]),
				),
			},
			errors: [400, 404, 500, 503],
		}),
	}, async (request, reply) => {
		const libraryId = parseId(request);
		const input = programItemAdditionSchema.parse(request.body);
		if (!(await repository.getLibrary(libraryId))) {
			throw app.httpErrors.notFound('Library not found');
		}

		let itemIds: string[];
		let matchedItemCount: number;

		// Resolve authored IDs or the recursive catalog query to current canonical items.
		if (input.selection.type === 'items') {
			const items = await repository.listMediaItemsByIds(libraryId, input.selection.itemIds);
			if (items.length !== input.selection.itemIds.length) {
				throw app.httpErrors.badRequest('Every selected item must belong to this library');
			}

			itemIds = [...new Set(items.map((item) => item.id))];
			matchedItemCount = itemIds.length;
		}
		else {
			const selection = repository.resolveProgramItemSelection(
				libraryId,
				input.selection.query,
				config.maxExplicitMediaItems,
			);
			itemIds = selection.itemIds;
			matchedItemCount = selection.matchedItemCount;
		}

		if (matchedItemCount === 0) {
			throw app.httpErrors.badRequest('No indexed items match this selection');
		}
		if (matchedItemCount > config.maxExplicitMediaItems) {
			throw app.httpErrors.conflict(
				`${matchedItemCount.toLocaleString()} matching items exceed the ${config.maxExplicitMediaItems.toLocaleString()}-item program limit`,
			);
		}

		// Create a new program or atomically append to the compatible destination.
		if (input.destination.type === 'new') {
			const program = await repository.createProgram({
				name: input.destination.name,
				config: {
					type: 'content',
					source: {
						type: 'collection',
						libraryId,
						itemIds,
						sort: { type: 'date-added', direction: 'asc' },
					},
					strategy: input.destination.strategy,
				},
			});
			repository.invalidateSchedulingCatalog();
			events.publish({
				type: 'scheduling.changed',
				data: { entity: 'program', change: 'created', id: program.id },
			});
			return reply.status(201).send({
				program,
				created: true,
				matchedItemCount,
				addedItemCount: itemIds.length,
				alreadySelectedCount: 0,
			});
		}

		const result = repository.appendProgramItems(
			input.destination.programId,
			libraryId,
			itemIds,
			input.confirmedAdditionToken,
			config.maxExplicitMediaItems,
		);
		if (result.status === 'not-found') {
			throw app.httpErrors.notFound('Program not found');
		}
		if (result.status === 'incompatible') {
			throw app.httpErrors.conflict(
				'The destination must be a selected-items program from this library',
			);
		}
		if (result.status === 'capacity') {
			throw app.httpErrors.conflict(
				`${result.addedItemCount.toLocaleString()} new items cannot fit in the program's ${result.remainingItemCount.toLocaleString()} remaining slots`,
			);
		}
		if (result.status === 'confirmation-required') {
			const items = await repository.listMediaItemsByIds(libraryId, result.addedItemIds);
			return reply.status(409).send({
				code: 'program_item_confirmation_required',
				message: 'Confirm this program addition',
				details: {
					addedItemCount: result.addedItemCount,
					alreadySelectedCount: result.alreadySelectedCount,
					confirmationToken: result.confirmationToken,
					items: items.map((item) => ({
						id: item.id,
						title: item.title,
						year: item.year,
						artworkUrl: item.artworkUrl,
					})),
				},
				requestId: request.id,
			});
		}

		if (result.changed) {
			events.publish({
				type: 'scheduling.changed',
				data: { entity: 'program', change: 'updated', id: result.program.id },
			});
		}
		return {
			program: result.program,
			created: false,
			matchedItemCount,
			addedItemCount: result.addedItemCount,
			alreadySelectedCount: result.alreadySelectedCount,
		};
	});
	app.get('/api/v1/programs/:id', {
		schema: apiOperation({
			operationId: 'getProgram',
			tags: ['Programs'],
			summary: 'Read a content program',
			params: idParamsSchema,
			response: { 200: responseContent('Content program', 'application/json', schedulingProgramSchema) },
			errors: [400, 404, 500, 503],
		}),
	}, async (request) => {
		const program = await repository.getProgram(parseId(request));
		if (!program) {
			throw app.httpErrors.notFound('Program not found');
		}

		return program;
	});
	app.patch('/api/v1/programs/:id', {
		schema: apiOperation({
			operationId: 'updateProgram',
			tags: ['Programs'],
			summary: 'Update mutable program settings',
			description: 'Program type, content source type, and source library are fixed after creation.',
			params: idParamsSchema,
			body: programUpdateSchema,
			response: { 200: responseContent('Updated program', 'application/json', schedulingProgramSchema) },
			errors: [400, 404, 409, 500, 503],
		}),
	}, async (request) => {
		const input = programUpdateSchema.parse(request.body);
		const itemCount = explicitItemCount(input.config);
		if (itemCount !== null && itemCount > config.maxExplicitMediaItems) {
			throw app.httpErrors.conflict(
				`The program exceeds the configured ${config.maxExplicitMediaItems.toLocaleString()}-item limit`,
			);
		}

		const program = await repository.updateProgram(
			parseId(request),
			input,
		);
		if (!program) {
			throw app.httpErrors.notFound('Program not found');
		}

		events.publish({
			type: 'scheduling.changed',
			data: { entity: 'program', change: 'updated', id: program.id },
		});
		return program;
	});
	app.delete('/api/v1/programs/:id', {
		schema: apiOperation({
			operationId: 'deleteProgram',
			tags: ['Programs'],
			summary: 'Delete an unused content program',
			params: idParamsSchema,
			response: { 204: emptyResponseSchema },
			errors: [400, 404, 409, 500, 503],
		}),
	}, async (request, reply) => {
		const id = parseId(request);
		if (!(await repository.deleteProgram(id))) {
			throw app.httpErrors.notFound('Program not found');
		}

		events.publish({
			type: 'scheduling.changed',
			data: { entity: 'program', change: 'deleted', id },
		});
		return reply.status(204).send();
	});

	// Scheduling dashboard summary.
	app.get('/api/v1/scheduling/overview', {
		schema: apiOperation({
			operationId: 'getSchedulingOverview',
			tags: ['Scheduling'],
			summary: 'Read scheduling configuration and health',
			response: { 200: responseContent('Scheduling overview', 'application/json', schedulingOverviewSchema) },
			errors: [500, 503],
		}),
	}, async () => {
		const programsPromise = repository.listPrograms();
		const [programs, templates, channelSchedules, catalog] = await Promise.all([
			programsPromise,
			repository.listScheduleTemplates(),
			repository.listChannelSchedules(),
			programsPromise.then((programs) => repository.getSchedulingCatalog(programs)),
		]);
		return {
			programs,
			templates,
			channelSchedules,
			programStatuses: schedulingProgramStatuses(programs, catalog),
		};
	});

	// Daily template definitions and channel assignments.
	app.get('/api/v1/schedule-templates', {
		schema: apiOperation({
			operationId: 'listScheduleTemplates',
			tags: ['Schedule templates'],
			summary: 'List daily schedule templates',
			response: { 200: responseContent('Configured templates', 'application/json', z.array(scheduleTemplateSchema)) },
			errors: [500, 503],
		}),
	}, async () => repository.listScheduleTemplates());
	app.post('/api/v1/schedule-templates', {
		schema: apiOperation({
			operationId: 'createScheduleTemplate',
			tags: ['Schedule templates'],
			summary: 'Create a daily schedule template',
			body: scheduleTemplateCreateSchema,
			response: { 201: responseContent('Created template', 'application/json', scheduleTemplateSchema) },
			errors: [400, 409, 422, 500, 503],
		}),
	}, async (request, reply) => {
		const template = await repository.createScheduleTemplate(
			scheduleTemplateCreateSchema.parse(request.body),
		);
		events.publish({
			type: 'scheduling.changed',
			data: { entity: 'template', change: 'created', id: template.id },
		});
		return reply.status(201).send(template);
	});
	app.get('/api/v1/schedule-templates/:id', {
		schema: apiOperation({
			operationId: 'getScheduleTemplate',
			tags: ['Schedule templates'],
			summary: 'Read a daily schedule template',
			params: idParamsSchema,
			response: { 200: responseContent('Schedule template', 'application/json', scheduleTemplateSchema) },
			errors: [400, 404, 500, 503],
		}),
	}, async (request) => {
		const template = await repository.getScheduleTemplate(parseId(request));
		if (!template) {
			throw app.httpErrors.notFound('Schedule template not found');
		}

		return template;
	});
	app.patch('/api/v1/schedule-templates/:id', {
		schema: apiOperation({
			operationId: 'updateScheduleTemplate',
			tags: ['Schedule templates'],
			summary: 'Update a daily schedule template',
			params: idParamsSchema,
			body: scheduleTemplateUpdateSchema,
			response: { 200: responseContent('Updated template', 'application/json', scheduleTemplateSchema) },
			errors: [400, 404, 409, 422, 500, 503],
		}),
	}, async (request) => {
		const template = await repository.updateScheduleTemplate(
			parseId(request),
			scheduleTemplateUpdateSchema.parse(request.body),
		);
		if (!template) {
			throw app.httpErrors.notFound('Schedule template not found');
		}

		events.publish({
			type: 'scheduling.changed',
			data: { entity: 'template', change: 'updated', id: template.id },
		});
		return template;
	});
	app.delete('/api/v1/schedule-templates/:id', {
		schema: apiOperation({
			operationId: 'deleteScheduleTemplate',
			tags: ['Schedule templates'],
			summary: 'Delete an unused schedule template',
			params: idParamsSchema,
			response: { 204: emptyResponseSchema },
			errors: [400, 404, 409, 500, 503],
		}),
	}, async (request, reply) => {
		const id = parseId(request);
		if (!(await repository.deleteScheduleTemplate(id))) {
			throw app.httpErrors.notFound('Schedule template not found');
		}

		events.publish({
			type: 'scheduling.changed',
			data: { entity: 'template', change: 'deleted', id },
		});
		return reply.status(204).send();
	});
	app.put('/api/v1/schedule-templates/:id/assignments', {
		schema: apiOperation({
			operationId: 'setTemplateAssignments',
			tags: ['Schedule templates'],
			summary: 'Assign a template as a channel base',
			params: idParamsSchema,
			body: templateAssignmentsSchema,
			response: { 200: responseContent('Updated channel schedules', 'application/json', z.array(channelScheduleSchema)) },
			errors: [400, 404, 409, 500, 503],
		}),
	}, async (request) => {
		const id = parseId(request);
		const input = templateAssignmentsSchema.parse(request.body);
		const assignments = await repository.setTemplateAssignments(id, input.channelIds);
		events.publish({
			type: 'scheduling.changed',
			data: { entity: 'assignment', change: 'updated', id },
		});
		return assignments;
	});

	// Layered schedules assigned to individual channels.
	app.get('/api/v1/channels/:id/schedule', {
		schema: apiOperation({
			operationId: 'getChannelSchedule',
			tags: ['Channel schedules'],
			summary: 'Read a layered channel schedule',
			params: idParamsSchema,
			response: { 200: responseContent('Layered channel schedule', 'application/json', channelScheduleSchema) },
			errors: [400, 404, 500, 503],
		}),
	}, async (request) => {
		const id = parseId(request);
		if (!(await repository.getChannel(id))) {
			throw app.httpErrors.notFound('Channel not found');
		}

		const schedule = await repository.getChannelSchedule(id);
		if (!schedule) {
			throw app.httpErrors.notFound('Channel schedule not found');
		}

		return schedule;
	});
	app.put('/api/v1/channels/:id/schedule', {
		schema: apiOperation({
			operationId: 'setChannelSchedule',
			tags: ['Channel schedules'],
			summary: 'Replace a layered channel schedule',
			params: idParamsSchema,
			body: channelScheduleConfigSchema,
			response: { 200: responseContent('Updated channel schedule', 'application/json', channelScheduleSchema) },
			errors: [400, 404, 409, 422, 500, 503],
		}),
	}, async (request) => {
		const id = parseId(request);
		const schedule = await repository.setChannelSchedule(
			id,
			channelScheduleConfigSchema.parse(request.body),
		);
		if (!schedule) {
			throw app.httpErrors.notFound('Channel not found');
		}

		events.publish({
			type: 'scheduling.changed',
			data: { entity: 'assignment', change: 'updated', id },
		});
		return schedule;
	});
	app.delete('/api/v1/channels/:id/schedule', {
		schema: apiOperation({
			operationId: 'deleteChannelSchedule',
			tags: ['Channel schedules'],
			summary: 'Remove a channel schedule',
			params: idParamsSchema,
			response: { 204: emptyResponseSchema },
			errors: [400, 404, 500, 503],
		}),
	}, async (request, reply) => {
		const id = parseId(request);
		if (!(await repository.getChannel(id))) {
			throw app.httpErrors.notFound('Channel not found');
		}

		await repository.deleteChannelSchedule(id);
		events.publish({
			type: 'scheduling.changed',
			data: { entity: 'assignment', change: 'deleted', id },
		});
		return reply.status(204).send();
	});
	// Preview one channel using its persisted schedule and playback state.
	app.get('/api/v1/channels/:id/timeline-preview', {
		schema: apiOperation({
			operationId: 'previewChannelTimeline',
			tags: ['Schedule previews'],
			summary: 'Preview a persisted channel schedule',
			params: idParamsSchema,
			querystring: timelinePreviewQuerySchema,
			response: { 200: responseContent('Duration-aware timeline preview', 'application/json', timelinePreviewSchema) },
			errors: [400, 404, 422, 500, 503],
		}),
	}, async (request) => {
		const id = parseId(request);
		if (!(await repository.getChannel(id))) {
			throw app.httpErrors.notFound('Channel not found');
		}

		const query = timelinePreviewQuerySchema.parse(request.query);
		const schedule = await repository.getChannelSchedule(id);
		if (!schedule) {
			throw app.httpErrors.notFound('Channel schedule not found');
		}

		const programsPromise = repository.listPrograms();
		const [templates, programs, state] = await Promise.all([
			repository.listScheduleTemplates(),
			programsPromise,
			repository.getSelectionState(id),
		]);
		const catalog = await repository.getSchedulingCatalog(
			programs,
			schedulingRootProgramIds(templates, [schedule]),
		);
		const template = templates.find((candidate) => candidate.id === schedule.defaultTemplateId);
		if (!template) {
			throw app.httpErrors.notFound('Schedule template not found');
		}

		const generated = await schedulingWorkers.generate({
			channelId: id,
			timeZone: config.timeZone,
			startDate: query.startDate ?? Temporal.Now.plainDateISO(config.timeZone).toString(),
			days: query.days,
			schedule,
			template,
			templates,
			programs,
			catalog,
			state,
		});
		return guideTimelinePreview(generated, templates, programs);
	});

	// Preview an unsaved template without mutating persistent playback state.
	app.post('/api/v1/timeline-preview', {
		schema: apiOperation({
			operationId: 'previewDraftTemplate',
			tags: ['Schedule previews'],
			summary: 'Preview an unsaved schedule template',
			body: timelineDraftPreviewSchema,
			response: { 200: responseContent('Duration-aware draft preview', 'application/json', timelinePreviewSchema) },
			errors: [400, 404, 422, 500, 503],
		}),
	}, async (request) => {
		const input = timelineDraftPreviewSchema.parse(request.body);
		if (input.channelId && !(await repository.getChannel(input.channelId))) {
			throw app.httpErrors.notFound('Channel not found');
		}

		const channelId = input.channelId ?? DRAFT_PREVIEW_CHANNEL_ID;
		const programsPromise = repository.listPrograms();
		const [programs, templates] = await Promise.all([
			programsPromise,
			repository.listScheduleTemplates(),
		]);
		const [state, currentSchedule] = input.channelId
			? await Promise.all([
				repository.getSelectionState(input.channelId),
				repository.getChannelSchedule(input.channelId),
			])
			: [[], null];
		validateTemplate(input.template, programs);
		const timestamp = currentTimestamp();
		const draftTemplate = { ...input.template, createdAt: timestamp, updatedAt: timestamp };
		const draftIsAssigned = Boolean(
			currentSchedule
			&& (currentSchedule.defaultTemplateId === input.template.id
				|| currentSchedule.layers.some((layer) => layer.templateId === input.template.id)),
		);
		const previewSchedule
			= draftIsAssigned && currentSchedule
				? currentSchedule
				: {
					channelId,
					defaultTemplateId: input.template.id,
					layers: [],
					defaultFiller: currentSchedule?.defaultFiller ?? null,
					createdAt: currentSchedule?.createdAt ?? timestamp,
					updatedAt: timestamp,
				};
		const previewTemplates = templates.some((template) => template.id === input.template.id)
			? templates.map((template) =>
				template.id === input.template.id
					? { ...draftTemplate, createdAt: template.createdAt }
					: template)
			: [...templates, draftTemplate];
		const baseTemplate = previewTemplates.find(
			(template) => template.id === previewSchedule.defaultTemplateId,
		);
		if (!baseTemplate) {
			throw app.httpErrors.notFound('Base schedule template not found');
		}

		const catalog = await repository.getSchedulingCatalog(
			programs,
			schedulingRootProgramIds(previewTemplates, [previewSchedule]),
		);
		const generated = await schedulingWorkers.generate({
			channelId,
			timeZone: config.timeZone,
			startDate: input.startDate ?? Temporal.Now.plainDateISO(config.timeZone).toString(),
			days: input.days,
			schedule: previewSchedule,
			template: baseTemplate,
			templates: previewTemplates,
			programs,
			catalog,
			state,
		});
		return guideTimelinePreview(generated, previewTemplates, programs);
	});

	// Preview an unsaved layered channel schedule.
	app.post('/api/v1/channel-schedule-preview', {
		schema: apiOperation({
			operationId: 'previewDraftChannelSchedule',
			tags: ['Schedule previews'],
			summary: 'Preview an unsaved layered channel schedule',
			body: channelScheduleDraftPreviewSchema,
			response: { 200: responseContent('Duration-aware layered preview', 'application/json', timelinePreviewSchema) },
			errors: [400, 404, 422, 500, 503],
		}),
	}, async (request) => {
		const input = channelScheduleDraftPreviewSchema.parse(request.body);
		if (!(await repository.getChannel(input.channelId))) {
			throw app.httpErrors.notFound('Channel not found');
		}

		const programsPromise = repository.listPrograms();
		const [templates, programs, state] = await Promise.all([
			repository.listScheduleTemplates(),
			programsPromise,
			repository.getSelectionState(input.channelId),
		]);
		const template = templates.find(
			(candidate) => candidate.id === input.schedule.defaultTemplateId,
		);
		if (!template) {
			throw app.httpErrors.notFound('Base schedule template not found');
		}

		const timestamp = currentTimestamp();
		const draftSchedule = {
			...input.schedule,
			channelId: input.channelId,
			createdAt: timestamp,
			updatedAt: timestamp,
		};
		const catalog = await repository.getSchedulingCatalog(
			programs,
			schedulingRootProgramIds(templates, [draftSchedule]),
		);
		const generated = await schedulingWorkers.generate({
			channelId: input.channelId,
			timeZone: config.timeZone,
			startDate: input.startDate,
			days: input.days,
			schedule: draftSchedule,
			template,
			templates,
			programs,
			catalog,
			state,
		});
		return guideTimelinePreview(generated, templates, programs);
	});

}
