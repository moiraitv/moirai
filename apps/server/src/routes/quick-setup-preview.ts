import type { FastifyInstance } from 'fastify';
import { Temporal } from '@js-temporal/polyfill';
import { quickChannelSetupCreateSchema, type SchedulingProgram } from '@moirai/shared';
import { quickChannelSetupPreviewResultSchema } from '@moirai/shared/api-contracts';
import type { AppConfig } from '../config.js';
import type { Repository } from '../repository/index.js';
import type { SchedulingWorkerPool } from '../scheduling/worker-pool.js';
import { schedulingProgramStatuses } from '../scheduling/status.js';
import { libraryTypeMediaKind } from '../scheduling/quick-setup-resources.js';
import { publicTimelineIssue } from '../scheduling/timeline-issues.js';
import { apiOperation, responseContent } from './contracts.js';

/** Read-only services used to resolve an uncommitted channel's sample day. */
interface QuickSetupPreviewDependencies {
	config: AppConfig;
	repository: Repository;
	schedulingWorkers: SchedulingWorkerPool;
}

/** Preview the same resources as creation without writes, reservations, or live events. */
export function registerQuickSetupPreviewRoute(
	app: FastifyInstance,
	{ config, repository, schedulingWorkers }: QuickSetupPreviewDependencies,
): void {
	app.post('/api/v1/quick-channel-setups/preview', {
		schema: apiOperation({
			operationId: 'previewQuickChannelSetup',
			tags: ['Channels', 'Schedule previews'],
			summary: 'Preview media samples and a resolved day before creating a channel',
			description: 'Read-only illustrative preview; creates no resources or playback state and reserves no names.',
			body: quickChannelSetupCreateSchema,
			response: { 200: responseContent('Quick Setup review', 'application/json', quickChannelSetupPreviewResultSchema) },
			errors: [400, 422, 500, 503],
		}),
	}, async (request) => {
		const input = quickChannelSetupCreateSchema.parse(request.body);
		const { program, template, schedule, channel } = repository.previewQuickChannelSetup(input, config.maxExplicitMediaItems);
		const libraryProgram: SchedulingProgram = {
			...program,
			id: '00000000-0000-4000-8000-000000000006',
			config: {
				type: 'content',
				source: { type: 'library-query', libraryId: input.libraryId, kinds: [libraryTypeMediaKind(input.scenario)], genres: [] },
				strategy: { type: 'sequential' },
			},
		};
		// One library catalog serves both bounded samples and the worker's duration-aware resolution.
		const catalog = await repository.getSchedulingCatalog([program, libraryProgram]);
		const [library, programming] = schedulingProgramStatuses([libraryProgram, program], catalog);
		const generated = await schedulingWorkers.generate({
			channelId: channel.id, timeZone: config.timeZone,
			startDate: Temporal.Now.plainDateISO(config.timeZone).toString(), days: 1,
			schedule, template, templates: [template], programs: [program], catalog, state: [],
		});
		return {
			library: { items: library!.previewItems, indexedItemCount: library!.indexedItemCount },
			programming: { items: programming!.previewItems, indexedItemCount: programming!.indexedItemCount },
			templateName: template.name,
			schedule: { ...generated, issues: generated.issues.map(publicTimelineIssue) },
		};
	});
}
