import type { FastifyInstance } from 'fastify';
import { programContentBrowseRequestSchema } from '@moirai/shared';
import { mediaSourcePickerResultSchema } from '@moirai/shared/api-contracts';
import type { SchedulingWorkerPool } from '../scheduling/worker-pool.js';
import { apiOperation, responseContent } from './contracts.js';
import { PROGRAM_REQUEST_BODY_LIMIT } from './media-request-limits.js';
import { sendWorkerJson, workerRequestSignal } from './worker-response.js';

/** Register a read-only browser over the current membership of an unsaved Content source. */
export function registerProgramContentRoutes(app: FastifyInstance, schedulingWorkers: SchedulingWorkerPool): void {
	app.post('/api/v1/programs/content-options', {
		bodyLimit: PROGRAM_REQUEST_BODY_LIMIT,
		schema: apiOperation({ operationId: 'browseProgramContent', tags: ['Programs'],
			summary: 'Browse current indexed content for a draft Program', body: programContentBrowseRequestSchema,
			response: { 200: responseContent('Current content hierarchy page', 'application/json', mediaSourcePickerResultSchema) },
			errors: [400, 404, 413, 500, 503] }),
	}, async (request, reply) => {
		const result = await schedulingWorkers.read({ kind: 'program-content', input: programContentBrowseRequestSchema.parse(request.body) }, workerRequestSignal(reply));
		return sendWorkerJson(reply, result.body);
	});
}
