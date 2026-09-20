import { semanticSource } from '../semantic/source.js';
import { refinementTexts } from '../semantic/refinement.js';
import type { FastifyInstance } from 'fastify';
import { semanticProgramConfigSchema, type SchedulingProgram } from '@moirai/shared';
import { schedulingProgramStatusSchema, semanticRetryResultSchema } from '@moirai/shared/api-contracts';
import type { Repository } from '../repository/index.js';
import { similarityProgramStatus } from '../semantic/status.js';
import { apiOperation, responseContent } from './contracts.js';

/** Identity for a read-only draft, never inserted into Program or seed storage. */
const PREVIEW_PROGRAM_ID = '00000000-0000-4000-8000-000000000002';

/** Expose bounded semantic samples for unsaved editor settings without touching seed state. */
export function registerSemanticProgramRoutes(app: FastifyInstance, repository: Repository, requestEmbeddingWork?: (includeMedia?: boolean) => void): void {
	app.post('/api/v1/programs/similarity-preview', {
		schema: apiOperation({ operationId: 'previewSimilarityProgram', tags: ['Programs'],
			summary: 'Sample related media for Similar Items or Theme settings', body: semanticProgramConfigSchema,
			response: { 200: responseContent('Sample matches and embedding status', 'application/json', schedulingProgramStatusSchema) },
			errors: [400, 500, 503] }),
	}, async (request) => {
		const config = semanticProgramConfigSchema.parse(request.body);
		const programs = await repository.listPrograms();
		const draft: SchedulingProgram = { id: PREVIEW_PROGRAM_ID, name: 'Sample matches', config,
			createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
		const catalog = await repository.getSchedulingCatalog([...programs, draft], [draft.id]);
		const source = semanticSource(config, programs, catalog);
		if (!source.valid) {
			throw app.httpErrors.badRequest(source.missing);
		}
		if (refinementTexts(config).some((text) => catalog.semantic?.preferences?.[text]?.status === 'pending')) {
			requestEmbeddingWork?.();
		}
		return similarityProgramStatus(draft, programs, catalog);
	});
	app.post('/api/v1/programs/similarity-retry', {
		schema: apiOperation({ operationId: 'retrySimilarityEmbeddings', tags: ['Programs'],
			summary: 'Retry failed embeddings for Similar Items or Theme settings', body: semanticProgramConfigSchema,
			response: { 200: responseContent('Number of failed embeddings queued', 'application/json', semanticRetryResultSchema) },
			errors: [400, 500, 503] }),
	}, async (request) => {
		const config = semanticProgramConfigSchema.parse(request.body);
		const programs = await repository.listPrograms();
		const draft: SchedulingProgram = { id: PREVIEW_PROGRAM_ID, name: 'Retry embeddings', config,
			createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
		const catalog = await repository.getSchedulingCatalog([...programs, draft], [draft.id]);
		const source = semanticSource(config, programs, catalog);
		if (!source.valid) {
			throw app.httpErrors.badRequest(source.missing);
		}
		const ids = [...source.sourceIds, ...source.items.map((media) => media.id)];
		const queued = repository.semantic.retryFailed(ids, refinementTexts(config));
		if (queued) {
			repository.invalidateSchedulingCatalog();
			requestEmbeddingWork?.(true);
		}
		return { queued };
	});
}
