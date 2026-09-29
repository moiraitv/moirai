import { PassThrough } from 'node:stream';
import { aiSelectionEventSchema, type AiProgress, type AiProgressDetails, type AiSelectionEvent } from '@moirai/shared';
import type { FastifyInstance } from 'fastify';
import { aiContentSelectionRequestSchema, aiContentSelectionResponseSchema, aiStatusSchema } from '@moirai/shared';
import type { AppConfig } from '../config.js';
import type { Repository } from '../repository/index.js';
import type { EmbeddingWakeStatus } from '../semantic/service.js';
import { selectionFailure } from '../ai/errors.js';
import { generateAiSelection } from '../ai/pipeline.js';
import { AiRunLogger } from '../ai/run-logging.js';
import { productionAiRequestOptions } from '../ai/provider.js';
import type { AiSettingsService } from '../ai/settings.js';
import { loadAiEmbeddings } from '../ai/embeddings.js';
import { authenticatedSession } from '../auth/http.js';
import { apiOperation, responseContent, multiContentResponse } from './contracts.js';

import { workerRequestSignal } from './worker-response.js';
import { registerAiGenerationRoutes } from './ai-generations.js';
import { registerAiSettingsRoutes } from './ai-settings.js';

/** Services required to expose AI content selection. */
interface AiRouteDependencies {
	config: AppConfig;
	aiSettings?: AiSettingsService;
	repository: Repository;
	requestEmbeddingWork?: (includeMedia?: boolean, concepts?: string[]) => EmbeddingWakeStatus | void;
}

/** Register AI availability and one-shot content selection. */
export function registerAiRoutes(
	app: FastifyInstance,
	{ config, aiSettings, repository, requestEmbeddingWork }: AiRouteDependencies,
): void {
	const jobs = registerAiGenerationRoutes(app, { config, repository, ...(aiSettings ? { aiSettings } : {}),
		...(requestEmbeddingWork ? { requestEmbeddingWork } : {}) });
	if (aiSettings) {
		registerAiSettingsRoutes(app, aiSettings);
	}
	app.get('/api/v1/ai', {
		schema: apiOperation({
			operationId: 'getAiStatus',
			tags: ['AI'],
			summary: 'Report whether AI content selection is enabled',
			response: { 200: responseContent('AI availability', 'application/json', aiStatusSchema) },
			errors: [401, 500],
		}),
	}, async () => ({ configured: (aiSettings?.active() ?? config.ai) !== null }));

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
		const ai = aiSettings?.active() ?? config.ai;
		if (!ai) {
			throw Object.assign(new Error('An OpenAI-compatible API key is not configured.'), {
				statusCode: 503,
				expose: true,
			});
		}
		const activeAi = ai;

		const body = aiContentSelectionRequestSchema.parse(request.body);
		const library = await repository.getLibrary(body.libraryId);
		if (!library) {
			throw Object.assign(new Error('Library not found.'), { statusCode: 404, expose: true });
		}

		const libraryType = library.typeKey;
		const signal = workerRequestSignal(reply);
		const release = jobs.acquire(authenticatedSession(request).identity.id);
		/** Validate the final selection before publishing it to either transport. */
		async function generate(onProgress?: (status: AiProgress, details?: AiProgressDetails) => void) {
			const runLog = new AiRunLogger(
				request.log,
				activeAi,
				body.libraryId,
				body.maxResults ?? null,
			);
			runLog.start();
			try {
				const result = await generateAiSelection(activeAi, body.prompt, libraryType, {
					loadCatalog: () => repository.aiCatalog(body.libraryId),
					loadVectors: (concepts, generationSignal) => loadAiEmbeddings(repository.semantic, body.libraryId, concepts, generationSignal, requestEmbeddingWork),
					...(!activeAi.webSearch ? { fastLocalReview: true } : {}),
					requestOptions: productionAiRequestOptions(activeAi),
					onMetrics: metrics => runLog.setMetrics(metrics),
				}, { onProgress: (status, details) => {
					runLog.progress(status, details);
					onProgress?.(status, details);
				}, signal }, body.maxResults ?? Infinity);
				result.itemIds = result.itemIds.slice(0, config.maxExplicitMediaItems);
				runLog.complete(result);
				return result;
			}
			catch (cause) {
				if (signal.aborted) {
					runLog.cancel();
				}
				else {
					runLog.fail(cause);
				}
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
