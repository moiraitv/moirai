import { afterEach, expect, it, vi } from 'vitest';
import { loadAiEmbeddings, AI_QUERY_EMBEDDING_WAIT_MS } from '@server/ai/embeddings.js';
import type { SemanticRepository } from '@server/repository/semantic.js';

afterEach(() => vi.useRealTimers());

it('waits only for query preparation then uses nonsemantic fallback without media backfill', async () => {
	vi.useFakeTimers();
	const work = vi.fn();
	const repository = { retrievalVectors: () => ({}), preferences: { catalog: () => ({ space: { status: 'pending' } }) } } as unknown as SemanticRepository;
	const pending = loadAiEmbeddings(repository, 'library', ['space'], new AbortController().signal, work);
	await vi.advanceTimersByTimeAsync(AI_QUERY_EMBEDDING_WAIT_MS);
	expect(await pending).toEqual({ vectors: {}, queries: [], available: false, issue: 'timeout' });
	expect(work).toHaveBeenCalledExactlyOnceWith(false, ['space']);
});

it.each([['paused', 'service-paused'], ['stopped', 'service-stopped']] as const)('reports a %s inference service without waiting', async (status, issue) => {
	const work = vi.fn(() => status);
	const repository = { retrievalVectors: () => ({ item: [1, 0] }), preferences: { catalog: () => ({ space: { status: 'pending' } }) } } as unknown as SemanticRepository;
	expect(await loadAiEmbeddings(repository, 'library', ['space'], new AbortController().signal, work))
		.toEqual({ vectors: { item: [1, 0] }, queries: [], available: false, issue });
	expect(work).toHaveBeenCalledExactlyOnceWith(false, ['space']);
});

it('reports a worker preparation failure without waiting for the full deadline', async () => {
	vi.useFakeTimers();
	const work = vi.fn(() => 'scheduled' as const);
	let reads = 0;
	const repository = { retrievalVectors: () => ({ item: [1, 0] }), preferences: { catalog: () => {
		reads += 1;
		return { space: reads === 1 ? { status: 'pending' } : { status: 'pending', error: 'preparation unavailable' } };
	} } } as unknown as SemanticRepository;
	const pending = loadAiEmbeddings(repository, 'library', ['space'], new AbortController().signal, work);
	await vi.advanceTimersByTimeAsync(500);
	expect(await pending).toEqual({ vectors: { item: [1, 0] }, queries: [], available: false, issue: 'worker-failed' });
});

it('reuses ready queries and media vectors without inference', async () => {
	const work = vi.fn();
	const repository = { retrievalVectors: () => ({ item: [1, 0] }), preferences: { catalog: () => ({ space: { status: 'ready', vector: [1, 0] } }) } } as unknown as SemanticRepository;
	expect(await loadAiEmbeddings(repository, 'library', ['space'], new AbortController().signal, work)).toEqual({ vectors: { item: [1, 0] }, queries: [[1, 0]], available: true });
	expect(work).not.toHaveBeenCalled();
});
