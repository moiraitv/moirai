import { sendWorkerJson, workerRequestSignal } from './worker-response.js';
import type { FastifyInstance } from 'fastify';
import {
	quickChannelQueryPreviewRequestSchema,
	quickChannelSetupCreateSchema,
} from '@moirai/shared';
import {
	quickChannelQueryPreviewResultSchema,
	quickChannelSetupResultSchema,
} from '@moirai/shared/api-contracts';
import type { AppConfig } from '../config.js';
import type { LiveEventHub } from '../operations/live-events.js';
import type { Repository } from '../repository/index.js';
import { registerQuickSetupPreviewRoute } from './quick-setup-preview.js';
import type { SchedulingWorkerPool } from '../scheduling/worker-pool.js';
import { apiOperation, responseContent } from './contracts.js';


/** Services required by atomic Quick Setup creation. */
interface QuickChannelSetupRouteDependencies {
	config: AppConfig;
	repository: Repository;
	events: LiveEventHub;
	schedulingWorkers: SchedulingWorkerPool;
}

/** Register the all-in-one simple channel creation endpoint. */
export function registerQuickChannelSetupRoutes(
	app: FastifyInstance,
	{ config, repository, events, schedulingWorkers }: QuickChannelSetupRouteDependencies,
): void {
	registerQuickSetupPreviewRoute(app, { config, schedulingWorkers });
	app.post('/api/v1/quick-channel-setups/query-preview', {
		schema: apiOperation({
			operationId: 'previewQuickChannelQuery',
			tags: ['Channels', 'Scheduling'],
			summary: 'Preview currently indexed media for a dynamic library query',
			body: quickChannelQueryPreviewRequestSchema,
			response: {
				200: responseContent(
					'Currently indexed query matches',
					'application/json',
					quickChannelQueryPreviewResultSchema,
				),
			},
			errors: [400, 404, 500, 503],
		}),
	}, async (request, reply) => {
		const result = await schedulingWorkers.read({ kind: 'query', input: quickChannelQueryPreviewRequestSchema.parse(request.body) }, workerRequestSignal(reply));
		return sendWorkerJson(reply, result.body);
	});

	app.post('/api/v1/quick-channel-setups', {
		schema: apiOperation({
			operationId: 'createQuickChannelSetup',
			tags: ['Channels', 'Scheduling'],
			summary: 'Create a simple playable channel and its scheduling resources',
			description:
				'Atomically creates a content program, continuous daily template, channel, and base assignment.',
			body: quickChannelSetupCreateSchema,
			response: {
				201: responseContent(
					'Created quick channel setup',
					'application/json',
					quickChannelSetupResultSchema,
				),
			},
			errors: [400, 404, 409, 422, 500, 503],
		}),
	}, async (request, reply) => {
		const input = quickChannelSetupCreateSchema.parse(request.body);
		const result = repository.createQuickChannelSetup(input, config.maxExplicitMediaItems);
		events.publish({
			type: 'scheduling.changed',
			data: { entity: 'program', change: 'created', id: result.program.id },
		});
		events.publish({
			type: 'scheduling.changed',
			data: { entity: 'template', change: 'created', id: result.template.id },
		});
		events.publish({
			type: 'scheduling.changed',
			data: { entity: 'assignment', change: 'updated', id: result.channel.id },
		});
		events.publish({
			type: 'channel.changed',
			data: { channelId: result.channel.id, change: 'created' },
		});
		return reply.status(201).send(result);
	});
}
