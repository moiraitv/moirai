import { AiSelectionError } from '../ai/errors.js';
import type { FastifyInstance } from 'fastify';
import { aiGenerationRequestSchema, aiGenerationSchema } from '@moirai/shared';
import type { AppConfig } from '../config.js';
import type { Repository } from '../repository/index.js';
import type { EmbeddingWakeStatus } from '../semantic/service.js';
import { authenticatedSession } from '../auth/http.js';
import { AiGenerations } from '../ai/generations.js';
import { generateAiSelection } from '../ai/pipeline.js';
import { AiRunLogger } from '../ai/run-logging.js';
import { productionAiRequestOptions } from '../ai/provider.js';
import type { AiSettingsService } from '../ai/settings.js';
import { loadAiEmbeddings } from '../ai/embeddings.js';
import { apiOperation, emptyResponseSchema, idParamsSchema, responseContent } from './contracts.js';
import { parseId } from './params.js';

/**
 * Register administrator-owned jobs whose lifetime is independent of a browser connection.
 * The returned registry also limits one-shot selection so both entry points share one cap.
 */
export function registerAiGenerationRoutes(app: FastifyInstance, dependencies: {
	config: AppConfig; repository: Repository; aiSettings?: AiSettingsService;
	requestEmbeddingWork?: (includeMedia?: boolean, concepts?: string[]) => EmbeddingWakeStatus | void;
}): AiGenerations {
	const { config, repository, aiSettings, requestEmbeddingWork } = dependencies;
	const jobs = new AiGenerations();
	app.addHook('onClose', async () => jobs.close());
	app.post('/api/v1/ai/generations', { schema: apiOperation({
		operationId: 'startAiGeneration', tags: ['AI'], summary: 'Start or reconnect to a retained AI generation',
		body: aiGenerationRequestSchema,
		response: { 202: responseContent('Generation accepted', 'application/json', aiGenerationSchema) },
		errors: [400, 401, 409, 503],
	}) }, async (request, reply) => {
		const ai = aiSettings?.active() ?? config.ai;
		if (!ai) {
			throw Object.assign(new Error('AI is not configured.'), { statusCode: 503, expose: true });
		}
		const body = aiGenerationRequestSchema.parse(request.body);
		const value = jobs.start(authenticatedSession(request).identity.id, body, async activity => {
			const runLog = new AiRunLogger(
				request.log,
				ai,
				body.libraryId,
				body.maxResults ?? null,
				body.id,
			);
			runLog.start();
			try {
				const library = await repository.getLibrary(body.libraryId);
				if (!library) {
					throw new AiSelectionError('Library not found.');
				}
				const result = await generateAiSelection(ai, body.prompt, library.typeKey, {
					loadCatalog: () => repository.aiCatalog(body.libraryId),
					loadVectors: (concepts, signal) => loadAiEmbeddings(repository.semantic, body.libraryId, concepts, signal, requestEmbeddingWork),
					...(!ai.webSearch ? { fastLocalReview: true } : {}),
					requestOptions: productionAiRequestOptions(ai),
					onMetrics: metrics => runLog.setMetrics(metrics),
				}, { ...activity, onProgress: (status, details) => {
					runLog.progress(status, details);
					activity.onProgress?.(status, details);
				} }, body.maxResults ?? Infinity);
				result.itemIds = result.itemIds.slice(0, config.maxExplicitMediaItems);
				runLog.complete(result);
				return result;
			}
			catch (cause) {
				if (!activity.signal?.aborted) {
					runLog.fail(cause);
				}
				throw cause;
			}
		});
		return reply.code(202).send(value);
	});
	app.get('/api/v1/ai/generations/:id', { schema: apiOperation({
		operationId: 'getAiGeneration', tags: ['AI'], summary: 'Read generation progress or its complete result', params: idParamsSchema,
		response: { 200: responseContent('Generation state', 'application/json', aiGenerationSchema) }, errors: [400, 401, 404],
	}) }, async (request, reply) => reply.header('Cache-Control', 'no-store').send(jobs.get(authenticatedSession(request).identity.id, parseId(request))));
	app.delete('/api/v1/ai/generations/:id', { schema: apiOperation({
		operationId: 'cancelAiGeneration', tags: ['AI'], summary: 'Cancel a discarded generation', params: idParamsSchema,
		response: { 204: responseContent('Cancelled', 'application/json', emptyResponseSchema) }, errors: [400, 401, 404],
	}) }, async (request, reply) => {
		const id = parseId(request);
		jobs.cancel(authenticatedSession(request).identity.id, id);
		request.log.info({ aiGeneration: { id } }, 'AI generation cancelled');
		return reply.code(204).send();
	});
	return jobs;
}
