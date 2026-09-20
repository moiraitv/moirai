import { describe, expect, it } from 'vitest';
import { dot, normalizeVector, rankSemanticCandidates } from '@server/semantic/ranking.js';
import { semanticInput, semanticInputHash } from '@server/semantic/input.js';

const anchors = [[1, 0, 0]];
const candidates = [
	{ id: 'a', vector: normalizeVector([1, 0.15, 0]) },
	{ id: 'b', vector: normalizeVector([1, 0.2, 0]) },
	{ id: 'c', vector: normalizeVector([1, -0.45, 0]) },
	{ id: 'unrelated', vector: [0, 0, 1] },
];

describe('semantic ranking', () => {
	it('uses relevance at the cohesive end and increases diversity without unrelated results', () => {
		const cohesive = rankSemanticCandidates(anchors, candidates, 2, 0);
		const varied = rankSemanticCandidates(anchors, candidates, 2, 100);
		expect(cohesive).toEqual(['a', 'b']);
		expect(varied).toEqual(['a', 'c']);
		const similarity = (ids: string[]) => dot(candidates.find((item) => item.id === ids[0])!.vector, candidates.find((item) => item.id === ids[1])!.vector);
		expect(similarity(varied)).toBeLessThan(similarity(cohesive));
		expect(rankSemanticCandidates(anchors, candidates, 20, 100)).not.toContain('unrelated');
	});
	it('is deterministic independent of candidate input order and gracefully reuses small pools', () => {
		expect(rankSemanticCandidates(anchors, candidates, 2, 35)).toEqual(rankSemanticCandidates(anchors, [...candidates].reverse(), 2, 35));
		expect(rankSemanticCandidates(anchors, candidates, 2, 0, ['a', 'b'])).toEqual(['c', 'a']);
		expect(rankSemanticCandidates(anchors, candidates.slice(0, 1), 20, 100, ['a'])).toEqual(['a']);
	});
	it('rejects invalid vectors and has no random fallback without anchors', () => {
		expect(() => normalizeVector([NaN])).toThrow();
		expect(() => normalizeVector([0, 0])).toThrow();
		expect(() => dot([1], [1, 0])).toThrow();
		expect(rankSemanticCandidates([], candidates, 2, 0)).toEqual([]);
	});
	it('embeds semantic context with stable unordered labels and excludes technical metadata', () => {
		const input = { title: 'Alien', kind: 'movie', plot: 'A crew encounters an alien.', metadata: { genres: ['Sci-fi', 'Horror'], tags: ['space'], path: '/secret', codec: 'h264' } };
		const first = semanticInput(input);
		expect(first).toContain('Overview: A crew encounters an alien.');
		expect(first).not.toContain('/secret');
		expect(first).not.toContain('h264');
		expect(semanticInputHash(first)).toBe(semanticInputHash(semanticInput({ ...input, metadata: { ...input.metadata, genres: ['Horror', 'Sci-fi'] } })));
		expect(semanticInput({ ...input, kind: 'episode' }, [{ title: 'Series', kind: 'show', plot: 'A space station', metadata: {} }])).toContain('Context: A space station');
	});
});

it('ranks 150,000 candidates without exceeding the runtime argument limit', () => {
	const pool = Array.from({ length: 150_000 }, (_, index) => ({ id: String(index).padStart(6, '0'), vector: [1, 0] }));
	expect(rankSemanticCandidates([[1, 0]], pool, 1, 35)).toEqual(['000000']);
});

it('prefers unseen items, then the least recently selected generation', () => {
	expect(rankSemanticCandidates(anchors, candidates, 1, 0, ['a'], undefined, [['b']])).toEqual(['c']);
	expect(rankSemanticCandidates(anchors, candidates, 2, 0, ['a'], undefined, [['b'], ['c']])).toEqual(['c', 'b']);
});
