import type { FastifyInstance } from 'fastify';
import { Temporal } from '@js-temporal/polyfill';
import { quickChannelSetupCreateSchema } from '@moirai/shared';
import { quickChannelSetupPreviewResultSchema } from '@moirai/shared/api-contracts';
import type { AppConfig } from '../config.js';
import type { SchedulingWorkerPool } from '../scheduling/worker-pool.js';
import { workerRequestSignal } from './worker-response.js';
import { apiOperation, responseContent } from './contracts.js';

/** Read-only services used to resolve an uncommitted channel's sample day. */
interface QuickSetupPreviewDependencies {
	config: AppConfig;
	schedulingWorkers: SchedulingWorkerPool;
}

/** Preview the same resources as creation without writes, reservations, or live events. */
export function registerQuickSetupPreviewRoute(
	app: FastifyInstance,
	{ config, schedulingWorkers }: QuickSetupPreviewDependencies,
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
	}, async (request, reply) => {
		const input = quickChannelSetupCreateSchema.parse(request.body);
		return schedulingWorkers.preview({
			kind: 'quick', input, timeZone: config.timeZone,
			startDate: Temporal.Now.plainDateISO(config.timeZone).toString(),
			maxExplicitMediaItems: config.maxExplicitMediaItems,
		}, workerRequestSignal(reply));
	});
}
