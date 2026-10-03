import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { SchedulableMedia, SelectionStateRecord } from '@moirai/shared';
import { selectOrderedCandidate } from '@server/scheduling/candidate-selection.js';
import { changedStateRecords, cloneState, indexOccupiedMedia, selectProgram, type SelectionContext } from '@server/scheduling/selection.js';

vi.mock('node:crypto', async importOriginal => {
	const original = await importOriginal<typeof import('node:crypto')>();
	return { ...original, createHash: vi.fn(original.createHash) };
});

function media(id: string, durationSeconds: number): SchedulableMedia {
	return { id, durationSeconds, libraryId: 'library', groupId: null, kind: 'movie', title: id, sortTitle: id,
		playbackPath: `/media/${id}.mp4`, seasonNumber: null, episodeNumber: null, genres: [], genreNames: [],
		plot: null, year: null, artworkUrl: null, availability: 'available' };
}

function context(items: SchedulableMedia[]): SelectionContext {
	return { programs: new Map(), catalog: { media: items, groupParents: {}, groupTitles: {}, libraryNames: { library: 'Library' }, libraryAvailability: { library: 'available' } },
		candidateCache: new Map(), blockedPrograms: new Set(), fitRejectionCount: 0, issues: [], issueKeys: new Set(), issueIndex: new Map(),
		boundaryOrigin: null, templateId: 'template', scheduleLayerId: null, slotId: 'slot', now: '2026-01-01T00:00:00Z',
		selectionStart: '2026-01-01T00:00:00Z', occupiedMedia: [], viewingPreferences: { itemScores: {}, showScores: {} } };
}

describe('candidate selection equivalence', () => {
	it('preserves collision priority, first-start rules, longest fit, repeat avoidance, and tie order', () => {
		const items = [media('a', 90), media('b', 30), media('c', 60), media('d', 60)];
		for (const collisions of [[], ['a'], ['b', 'c'], ['a', 'b', 'c', 'd']]) {
			for (const strict of [false, true]) {
				for (const fit of [null, 20, 60, 120]) {
					for (const mode of ['first-fit-arbitrary', 'best-fit'] as const) {
						for (const avoid of [null, 'a', 'c']) {
							const c = context(items);
							c.occupiedMedia = collisions.map(id => ({ mediaItemId: id, start: c.selectionStart, finish: '2026-01-01T01:00:00Z' }));
							c.occupiedMediaIndex = indexOccupiedMedia(c.occupiedMedia);
							const nonColliding = items.filter(item => !collisions.includes(item.id));
							let eligible = nonColliding.length ? nonColliding : items;
							if (avoid && eligible.some(item => item.id !== avoid && (fit === null || item.durationSeconds! <= fit))) {
								eligible = eligible.filter(item => item.id !== avoid);
							}
							const expected = fit === null ? eligible[0]
								: mode === 'first-fit-arbitrary' && strict ? eligible[0] && eligible[0].durationSeconds! <= fit ? eligible[0] : undefined
									: mode === 'first-fit-arbitrary' ? eligible.find(item => item.durationSeconds! <= fit)
										: eligible.filter(item => item.durationSeconds! <= fit).sort((left, right) => right.durationSeconds! - left.durationSeconds!)[0];
							// Strict sequential selection never applies repeat avoidance.
							if (!strict || !avoid) {
								expect(selectOrderedCandidate(items, c, fit, mode, strict, avoid)?.id).toBe(expected?.id);
							}
						}
					}
				}
			}
		}
	});

	it('expands only the winner when later movies have future occupancy', () => {
		const items = Array.from({ length: 1_000 }, (_, i) => media(`movie-${i}`, 120));
		const c = context(items);
		c.occupiedMedia = items.map(item => ({ mediaItemId: item.id, start: '2026-01-02T00:00:00Z', finish: '2026-01-03T00:00:00Z' }));
		c.occupiedMediaIndex = indexOccupiedMedia(c.occupiedMedia);
		let expanded = 0;
		c.mediaDuration = () => {
			expanded += 1;
			return 180;
		};
		expect(selectOrderedCandidate(items, c, null, 'first-fit-arbitrary', true)?.id).toBe('movie-0');
		expect(expanded).toBe(1);
	});
});

describe('speculative state ownership', () => {
	it('reuses configuration fingerprints within a generation and recomputes them in a new generation', () => {
		const items = [media('a', 60)];
		const c = context(items);
		const program = { id: 'program', name: 'Program', createdAt: c.now, updatedAt: c.now,
			config: { type: 'content' as const, source: { type: 'item' as const, itemId: 'a' }, strategy: { type: 'sequential' as const } } };
		let configurationReads = 0;
		Object.defineProperty(program.config, 'subtitlePreferences', { enumerable: true, get: () => {
			configurationReads += 1;
			return {};
		} });
		c.programs.set(program.id, program);
		const first = selectProgram(program.id, 'consumer', new Map(), c)!;
		expect(configurationReads).toBeGreaterThan(0);
		configurationReads = 0;
		selectProgram(program.id, 'consumer', first.state, c);
		expect(configurationReads).toBe(0);
		const next = context(items);
		next.programs.set(program.id, program);
		selectProgram(program.id, 'consumer', first.state, next);
		expect(configurationReads).toBeGreaterThan(0);
	});

	it.each(['sequential', 'shuffle', 'random', 'weighted-random'] as const)('isolates %s changes without inspecting unrelated state values', (strategy) => {
		const items = [media('a', 60), media('b', 30)];
		const c = context(items);
		c.programs.set('program', { id: 'program', name: 'Program', createdAt: c.now, updatedAt: c.now,
			config: { type: 'content', source: { type: 'collection', libraryId: 'library', itemIds: ['a', 'b'], sort: { type: 'name', direction: 'asc' } },
				strategy: strategy === 'sequential' ? { type: strategy } : { type: strategy, seed: 'fixture' } } });
		let unrelatedReads = 0;
		const source = new Map<string, SelectionStateRecord>();
		for (let i = 0; i < 1_000; i += 1) {
			source.set(`unused-${i}`, { consumerKey: `unused-${i}`, configFingerprint: 'unused', updatedAt: c.now,
				get value() {
					unrelatedReads += 1;
					return { type: 'sequential' as const, nextIndex: 0, lastItemId: null };
				} });
		}
		const first = selectProgram('program', 'consumer', source, c)!;
		const prior = structuredClone(first.state.get('consumer'));
		const second = selectProgram('program', 'consumer', first.state, c)!;
		expect(first.state.get('consumer')).toEqual(prior);
		expect(source.has('consumer')).toBe(false);
		expect(second.state.get('consumer')).not.toBe(first.state.get('consumer'));
		expect(changedStateRecords(source, first.state).map(entry => entry.consumerKey)).toEqual(['consumer']);
		expect(unrelatedReads).toBe(0);
		expect(selectProgram('program', 'consumer', first.state, c, 1)).toBeNull();
		expect(first.state.get('consumer')).toEqual(prior);
	});

	it('preserves the public deep-copy helper contract', () => {
		const record: SelectionStateRecord = { consumerKey: 'key', configFingerprint: 'config', updatedAt: 'now',
			value: { type: 'sequential', nextIndex: 0, lastItemId: null } };
		const copy = cloneState(new Map([['key', record]]));
		const value = copy.get('key')!.value;
		if (value.type !== 'sequential') {
			throw new Error('Expected sequential state');
		}
		value.nextIndex = 2;
		value.lastItemId = 'b';
		expect(record.value).toEqual({ type: 'sequential', nextIndex: 0, lastItemId: null });
		expect(copy.get('key')).not.toBe(record);
	});
});

it('reuses membership indexes across filler branches without caching clock-dependent choices', async () => {
	const { candidateIndex } = await import('@server/scheduling/candidate-index.js');
	const items = Array.from({ length: 1000 }, (_, index) => media(`item-${index}`, 30));
	const c = context(items);
	const first = candidateIndex(items, c);
	const branch = { ...c, selectionStart: '2026-01-02T00:00:00Z' };
	expect(candidateIndex(items, branch)).toBe(first);
	expect(first.byId.size).toBe(items.length);
	expect(first.byId.get('item-999')).toBe(items[999]);
	expect(candidateIndex([...items], c)).not.toBe(first);
	c.occupiedMedia = [{ mediaItemId: 'item-0', start: c.selectionStart, finish: '2026-01-01T01:00:00Z' }];
	branch.occupiedMedia = c.occupiedMedia;
	expect(selectOrderedCandidate(items, c, 30, 'first-fit-arbitrary')?.id).toBe('item-1');
	expect(selectOrderedCandidate(items, branch, 30, 'first-fit-arbitrary')?.id).toBe('item-0');
});

it('builds library and group indexes in catalog order without modifying input media', async () => {
	const { indexSchedulingCatalog } = await import('@server/scheduling/catalog.js');
	const items = Array.from({ length: 5000 }, (_, index) => ({ ...media(`item-${index}`, 30), groupId: index % 2 ? 'odd' : 'even' }));
	const c = context(items);
	const before = structuredClone(items);
	const indexed = indexSchedulingCatalog(c.catalog);
	expect(indexed.mediaByLibrary?.get('library')).toEqual(items);
	expect(indexed.mediaByGroup?.get('odd')).toEqual(items.filter(item => item.groupId === 'odd'));
	expect(indexed.mediaByGroup?.get('even')).toEqual(items.filter(item => item.groupId === 'even'));
	expect(items).toEqual(before);
	expect(c.catalog.mediaByLibrary).toBeUndefined();
});

it.each(['shuffle', 'random', 'weighted-random'] as const)('hashes each %s ordering key once for primary and filler selection', strategy => {
	const items = Array.from({ length: 1000 }, (_, index) => media(`item-${index}`, 30));
	for (const filler of [false, true]) {
		const c = context(items);
		c.programs.set('program', { id: 'program', name: 'Program', createdAt: c.now, updatedAt: c.now,
			config: { type: 'content', source: { type: 'library-query', libraryId: 'library', kinds: [], genres: [] }, strategy: { type: strategy, seed: 'fixture' } } });
		if (filler) {
			c.fillerSelection = { fullBudgetSeconds: 120, allowTruncation: false };
		}
		vi.mocked(createHash).mockClear();
		expect(selectProgram('program', 'consumer', new Map(), c)?.media).toBeDefined();
		expect(vi.mocked(createHash).mock.calls.length).toBeLessThanOrEqual(items.length + 2);
	}
});

it('does not repeatedly iterate growing library or group arrays during indexing', async () => {
	const { indexSchedulingCatalog } = await import('@server/scheduling/catalog.js');
	const items = Array.from({ length: 1000 }, (_, index) => ({ ...media(`item-${index}`, 30), groupId: 'group' }));
	const c = context(items);
	const original = Array.prototype[Symbol.iterator];
	let visits = 0;
	Array.prototype[Symbol.iterator] = function (this: unknown[]) {
		const iterator = original.call(this);
		const next = iterator.next.bind(iterator);
		const tracked = this === items || this[0] === items[0];
		iterator.next = () => {
			const result = next();
			if (tracked && !result.done) {
				visits += 1;
			}
			return result;
		};
		return iterator;
	};
	try {
		indexSchedulingCatalog(c.catalog);
	}
	finally {
		Array.prototype[Symbol.iterator] = original;
	}
	expect(visits).toBeLessThanOrEqual(items.length * 3);
});
