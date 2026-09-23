import { sendWorkerJson, workerRequestSignal } from './worker-response.js';
import type { SchedulingWorkerPool } from '../scheduling/worker-pool.js';
import type { FastifyInstance } from 'fastify';
import { semanticProgramConfigSchema } from '@moirai/shared';
import { schedulingProgramStatusSchema, semanticRetryResultSchema } from '@moirai/shared/api-contracts';
import type { Repository } from '../repository/index.js';
import { apiOperation, responseContent } from './contracts.js';


/** Expose bounded semantic samples for unsaved editor settings without touching seed state. */
export function registerSemanticProgramRoutes(app: FastifyInstance, repository: Repository, requestEmbeddingWork: ((includeMedia?: boolean) => void) | undefined, schedulingWorkers: SchedulingWorkerPool): void {
	app.post('/api/v1/programs/similarity-preview', {
		schema: apiOperation({ operationId: 'previewSimilarityProgram', tags: ['Programs'],
			summary: 'Sample related media for Similar Items or Theme settings', body: semanticProgramConfigSchema,
			response: { 200: responseContent('Sample matches and embedding status', 'application/json', schedulingProgramStatusSchema) },
			errors: [400, 500, 503] }),
	}, async (request, reply) => {
		const result = await schedulingWorkers.read({ kind: 'similarity', config: semanticProgramConfigSchema.parse(request.body) }, workerRequestSignal(reply));
		if (result.preferences?.length) {
			repository.semantic.preferences.catalog(result.preferences);
			requestEmbeddingWork?.();
		}
		return sendWorkerJson(reply, result.body);
	});
	app.post('/api/v1/programs/similarity-retry', {
		schema: apiOperation({ operationId: 'retrySimilarityEmbeddings', tags: ['Programs'],
			summary: 'Retry failed embeddings for Similar Items or Theme settings', body: semanticProgramConfigSchema,
			response: { 200: responseContent('Number of failed embeddings queued', 'application/json', semanticRetryResultSchema) },
			errors: [400, 500, 503] }),
	}, async (request, reply) => {
		const result = await schedulingWorkers.read({ kind: 'similarity', config: semanticProgramConfigSchema.parse(request.body), retry: true }, workerRequestSignal(reply));
		if (result.preferences?.length) {
			repository.semantic.preferences.catalog(result.preferences);
		}
		const queued = repository.semantic.retryFailed(result.retryItemIds ?? [], result.preferences ?? []);
		if (queued) {
			repository.invalidateSchedulingCatalog();
			requestEmbeddingWork?.(true);
		}
		return { queued };
	});
}
