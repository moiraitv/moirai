import { expect, it } from 'vitest';
import { AI_BATCH_BYTE_LIMIT, AI_BATCH_ITEM_LIMIT, AI_CATALOG_BYTE_LIMIT, candidateBatches, aiDiscoverySchema, parseAiJson } from '@server/ai/content-selection.js';
import { discoveredItems, shortlistCandidates } from '@server/ai/retrieval.js';

const movie = { id: 'known', title: 'Hidden battle', year: 2020, kind: 'movie', genres: ['Drama'] };
const discovery = { concepts: ['spaceship combat'], constraints: ['No documentaries'], candidates: [{ title: movie.title, year: movie.year }] };

it('rescues a discovered title with weak embeddings and metadata lacking the required feature', () => {
	const catalog = Array.from({ length: 3_000 }, (_, i) => ({ ...movie, id: String(i).padStart(5, '0'), title: `Space ${i}`, genres: ['Science Fiction'] }));
	catalog.push(movie);
	const vectors = Object.fromEntries(catalog.map(item => [item.id, item.id === movie.id ? [-1, 0] : [1, 0]]));
	const result = shortlistCandidates(catalog, discovery, vectors, [[1, 0]]);
	expect(result).toHaveLength(1_000);
	expect(result[0]!.id).toBe(movie.id);
	expect(new Set(result.map(item => item.id)).size).toBe(result.length);
});

it('does not interpret exclusions as local negative evidence and explores the ranked tail', () => {
	const catalog = Array.from({ length: 2_000 }, (_, i) => ({ ...movie, id: String(i).padStart(5, '0'), title: 'Drama' }));
	const result = shortlistCandidates(catalog, { ...discovery, candidates: [] });
	expect(result).toHaveLength(1_000);
	expect(result.some(item => Number(item.id) > 1_500)).toBe(true);
	expect(result).toEqual(shortlistCandidates([...catalog].reverse(), { ...discovery, candidates: [] }));
});

it('distinguishes same-named episodes and rejects ambiguous discoveries', () => {
	const episodes = ['Show A', 'Show B'].map(series => ({ ...movie, id: series, kind: 'episode', series, season: 1, episode: 2 }));
	expect(discoveredItems(episodes, discovery)).toEqual([]);
	expect(discoveredItems(episodes, { ...discovery, candidates: [{ ...discovery.candidates[0]!, series: 'Show B', season: 1, episode: 2 }] })).toEqual([episodes[1]]);
	expect(discoveredItems([movie, { ...movie, id: 'duplicate' }], discovery)).toEqual([]);
});

it('uses the larger episode shortlist without excluding missing-vector items', () => {
	const catalog = Array.from({ length: 13_000 }, (_, i) => ({ ...movie, id: String(i), kind: 'episode', series: 'Show', season: 1, episode: i }));
	expect(shortlistCandidates(catalog, { ...discovery, candidates: [] })).toHaveLength(1_500);
});

it('ranks bounded local plot matches without sending plots in candidate rows', () => {
	const catalog = Array.from({ length: 2_000 }, (_, i) => ({ ...movie, id: String(i).padStart(5, '0'), title: 'Untitled', genres: [], plot: null as string | null }));
	catalog.push({ ...movie, id: 'zzzzz', title: 'Untitled', genres: [], plot: 'Halloween night costumes and trick-or-treating' });
	const shortlisted = shortlistCandidates(catalog, { concepts: ['Halloween night'], constraints: [], candidates: [] });
	expect(shortlisted.some(item => item.id === 'zzzzz')).toBe(true);
	expect(candidateBatches(shortlisted).flat().find(row => row.item.id === 'zzzzz')?.line).not.toContain('Halloween');
});

it('bounds complete UTF-8 rows and batches without alphabetic truncation', () => {
	const rows = Array.from({ length: 1_500 }, (_, i) => ({ ...movie, id: String(i), title: `${'宇'.repeat(100)}${i}` }));
	const batches = candidateBatches(rows);
	expect(batches.flat().length).toBeLessThan(rows.length);
	let total = 0;
	for (const batch of batches) {
		const bytes = batch.reduce((sum, row) => sum + Buffer.byteLength(row.line) + 1, 0);
		expect(bytes).toBeLessThanOrEqual(AI_BATCH_BYTE_LIMIT);
		expect(batch.length).toBeLessThanOrEqual(AI_BATCH_ITEM_LIMIT);
		total += bytes;
	}
	expect(total).toBeLessThanOrEqual(AI_CATALOG_BYTE_LIMIT);
});

it.each(['not JSON', '{}', '{"concepts":[],"constraints":[],"candidates":[]}'])('rejects malformed discovery safely: %s', text => {
	expect(() => parseAiJson(text, aiDiscoverySchema)).toThrow('invalid selection');
});

it('declares episode series once in each batch and retains season/episode identities', () => {
	const batches = candidateBatches(Array.from({ length: 501 }, (_, i) => ({ ...movie, id: String(i), kind: 'episode', series: 'Series', seriesYear: 2020, season: 1, episode: i, rating: 8.2 })));
	expect(batches).toHaveLength(2);
	for (const batch of batches) {
		const lines = batch.flatMap(row => row.line.split('\n').map(line => JSON.parse(line)));
		expect(lines.filter(row => row[0] === 'series')).toEqual([['series', 's1', 'Series', 2020]]);
		expect(lines.filter(row => row[0] !== 'series').every(row => row[5] === 's1')).toBe(true);
		expect(lines.filter(row => row[0] !== 'series').every(row => row[8] === 8.2)).toBe(true);
	}
});

it('includes available ratings in compact movie rows without inventing missing scores', () => {
	const rows = candidateBatches([{ ...movie, rating: 7.6 }, { ...movie, id: 'unrated' }]).flat();
	expect(JSON.parse(rows[0]!.line)).toEqual(['1', movie.title, movie.year, movie.kind, movie.genres, 7.6]);
	expect(JSON.parse(rows[1]!.line)).toEqual(['2', movie.title, movie.year, movie.kind, movie.genres]);
});
