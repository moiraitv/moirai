import { setTimeout as delay } from 'node:timers/promises';
import type { SemanticRepository } from '../repository/semantic.js';
import type { EmbeddingWakeStatus } from '../semantic/service.js';
import type { AiRetrievalVectors } from './pipeline.js';

/** Interactive query inference may wait briefly, but never for whole-library backfill. */
export const AI_QUERY_EMBEDDING_WAIT_MS = 10_000;

/** Reuse cached media vectors and the existing bounded draft-query inference queue. */
export async function loadAiEmbeddings(
	repository: SemanticRepository, 
	libraryId: string, 
	concepts: string[], 
	signal: AbortSignal,
	requestWork?: (includeMedia?: boolean, concepts?: string[]) => EmbeddingWakeStatus | void,
): Promise<AiRetrievalVectors> {
	signal.throwIfAborted();
	const vectors = repository.retrievalVectors(libraryId);
	const deadline = Date.now() + AI_QUERY_EMBEDDING_WAIT_MS;
	let preferences = await repository.preferences.catalog(concepts, Boolean(requestWork));
	let issue: AiRetrievalVectors['issue'];
	if (requestWork && Object.values(preferences).some(item => item.status === 'pending')) {
		const wake = requestWork(false, concepts);
		issue = wake === 'paused' ? 'service-paused' : wake === 'stopped' ? 'service-stopped' : undefined;
		while (!issue && Date.now() < deadline && Object.values(preferences).some(item => item.status === 'pending' && !item.error)) {
			await delay(Math.min(500, Math.max(1, deadline - Date.now())), undefined, { signal });
			preferences = await repository.preferences.catalog(concepts, false);
		}
	}
	const queries = concepts.flatMap(concept => preferences[concept]?.vector ? [preferences[concept]!.vector!] : []);
	if (queries.length < concepts.length && !issue) {
		issue = Object.values(preferences).some(item => item.status === 'failed' || item.error) ? 'worker-failed'
			: requestWork ? 'timeout' : 'service-stopped';
	}
	return { vectors, queries, available: queries.length === concepts.length && Object.keys(vectors).length > 0,
		...(issue ? { issue } : {}) };
}
