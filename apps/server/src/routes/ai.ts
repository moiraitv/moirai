import { PassThrough } from 'node:stream';
import { aiSelectionEventSchema, type AiProgress, type AiProgressDetails, type AiSelectionEvent } from '@moirai/shared';
import type { FastifyInstance } from 'fastify';
import { aiContentSelectionRequestSchema, aiContentSelectionResponseSchema, aiStatusSchema } from '@moirai/shared';
import type { AppConfig } from '../config.js';
import type { Repository } from '../repository/index.js';
import type { EmbeddingWakeStatus } from '../semantic/service.js';
import { AiSelectionError, selectionFailure } from '../ai/errors.js';
import { generateAiSelection } from '../ai/pipeline.js';
import { loadAiEmbeddings } from '../ai/embeddings.js';
import { authenticatedSession } from '../auth/http.js';
import { apiOperation, responseContent, multiContentResponse } from './contracts.js';

import { workerRequestSignal } from './worker-response.js';
import { registerAiGenerationRoutes } from './ai-generations.js';

/** Services required to expose AI content selection. */
interface AiRouteDependencies {
	config: AppConfig;
	repository: Repository;
	requestEmbeddingWork?: (includeMedia?: boolean, concepts?: string[]) => EmbeddingWakeStatus | void;
}

/** Register AI availability and one-shot content selection. */
export function registerAiRoutes(
	app: FastifyInstance,
	{ config, repository, requestEmbeddingWork }: AiRouteDependencies,
): void {
	const jobs = registerAiGenerationRoutes(app, { config, repository, ...(requestEmbeddingWork ? { requestEmbeddingWork } : {}) });
	app.get('/api/v1/ai', {
		schema: apiOperation({
			operationId: 'getAiStatus',
			tags: ['AI'],
			summary: 'Report whether an OpenAI-compatible content model is configured',
			response: { 200: responseContent('AI availability', 'application/json', aiStatusSchema) },
			errors: [401, 500],
		}),
	}, async () => ({ configured: config.ai !== null }));

	app.post('/api/v1/ai/content-selection', {
		schema: apiOperation({
			operationId: 'selectAiContent',
			tags: ['AI'],
			summary: 'Match a prompt to frozen library items',
			body: aiContentSelectionRequestSchema,
			response: {
				200: multiContentResponse('Matched library items or SSE data events when Accept is text/event-stream', {
					'application/json': aiContentSelectionResponseSchema,
					'text/event-stream': aiSelectionEventSchema,
				}),
			},
			errors: [400, 401, 404, 422, 500, 503],
		}),
	}, async (request, reply) => {
		if (!config.ai) {
			throw Object.assign(new Error('An OpenAI-compatible API key is not configured.'), {
				statusCode: 503,
				expose: true,
			});
		}

		const body = aiContentSelectionRequestSchema.parse(request.body);
		const library = await repository.getLibrary(body.libraryId);
		if (!library) {
			throw Object.assign(new Error('Library not found.'), { statusCode: 404, expose: true });
		}

		const ai = config.ai;
		const libraryType = library.typeKey;
		const signal = workerRequestSignal(reply);
		const release = jobs.acquire(authenticatedSession(request).identity.id);
		/** Validate the final selection before publishing it to either transport. */
		async function generate(onProgress?: (status: AiProgress, details?: AiProgressDetails) => void) {
			try {
				const result = await generateAiSelection(ai, body.prompt, libraryType, {
					loadCatalog: () => repository.aiCatalog(body.libraryId),
					loadVectors: (concepts, generationSignal) => loadAiEmbeddings(repository.semantic, body.libraryId, concepts, generationSignal, requestEmbeddingWork),
					onMetrics: metrics => {
						if (metrics.searchBudgetOverrun) {
							request.log.warn({ aiGeneration: metrics }, 'AI generation exceeded its requested search budget');
						}
						else {
							request.log.info({ aiGeneration: metrics }, 'AI generation ended');
						}
					},
				}, { ...(onProgress ? { onProgress } : {}), signal }, body.maxResults);
				if (result.itemIds.length > config.maxExplicitMediaItems) {
					throw new AiSelectionError(`The match list exceeds ${config.maxExplicitMediaItems} items. Narrow the prompt.`);
				}
				return result;
			}
			catch (cause) {
				throw selectionFailure(cause);
			}
			finally {
				release();
			}
		}

		if (!request.headers.accept?.includes('text/event-stream')) {
			return generate();
		}

		const stream = new PassThrough();
		let lastStatus = '';
		/** Send only normalized application events to the browser. */
		function send(event: AiSelectionEvent): void {
			if (!signal.aborted) {
				stream.write(`data: ${JSON.stringify(event)}\n\n`);
			}
		}
		/** Deduplicate repeated provider events, including individual text tokens. */
		function progress(status: AiProgress, details?: AiProgressDetails): void {
			const key = JSON.stringify([status, details]);
			if (key !== lastStatus) {
				lastStatus = key;
				send({ type: 'progress', status, ...details });
			}
		}
		progress('generating');
		void generate(progress).then(result => {
			send({ type: 'result', result });
		}).catch(cause => {
			send({ type: 'error', message: cause instanceof Error ? cause.message : 'Generation failed. Try again.' });
		}).finally(() => stream.end());
		return reply.header('Cache-Control', 'no-cache').header('X-Accel-Buffering', 'no')
			.type('text/event-stream').send(stream);
	});
}
