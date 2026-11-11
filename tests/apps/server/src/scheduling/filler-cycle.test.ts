import { expect, it } from 'vitest';
import type { FillerBudget, SchedulableMedia, SchedulingProgram, SelectionStateRecord, SequenceOrdering } from '@moirai/shared';
import { planFiller } from '@server/scheduling/filler-plan.js';
import { SEQUENCE_FILLER_PROBE_LIMIT } from '@server/scheduling/sequence-filler.js';
import { indexSchedulingCatalog } from '@server/scheduling/catalog.js';
import { hasSelectionCollision, indexOccupiedMedia, selectProgram, type SelectionContext } from '@server/scheduling/selection.js';
import { selectOrderedCandidate } from '@server/scheduling/candidate-selection.js';

function fixture(durations = [200, 30, 40], strategy: 'sequential' | 'shuffle' | 'random' | 'weighted-random' = 'sequential') {
	const media: SchedulableMedia[] = durations.map((durationSeconds, index) => ({
		id: `item-${index}`, libraryId: 'library', groupId: null, kind: 'movie', title: `Item ${index}`,
		sortTitle: `item ${index}`, playbackPath: `/media/${index}.mp4`, durationSeconds,
		seasonNumber: null, episodeNumber: null, genres: [], genreNames: [], plot: null, year: null,
		artworkUrl: null, availability: 'available',
	}));
	const program: SchedulingProgram = { id: 'program', name: 'Filler', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
		config: { type: 'content', source: { type: 'collection', libraryId: 'library', itemIds: media.map(item => item.id), sort: { type: 'manual', itemIds: media.map(item => item.id) } },
			strategy: strategy === 'sequential' ? { type: strategy } : { type: strategy, seed: 'fixture' } } };
	const context: SelectionContext = { programs: new Map([[program.id, program]]),
		catalog: indexSchedulingCatalog({ media, groupParents: {}, groupTitles: {}, libraryNames: {}, libraryAvailability: { library: 'available' } }),
		candidateCache: new Map(), blockedPrograms: new Set(), fitRejectionCount: 0, issues: [], issueKeys: new Set(), issueIndex: new Map(),
		boundaryOrigin: null, templateId: 'template', scheduleLayerId: null, slotId: 'slot', now: '2026-01-01T00:00:00Z',
		selectionStart: '2026-01-01T00:00:00Z', occupiedMedia: [], viewingPreferences: { itemScores: {}, showScores: {} } };
	let state = new Map<string, SelectionStateRecord>();
	return { media, program, context,
		get state() {
			return state; 
		},
		set state(value: Map<string, SelectionStateRecord>) {
			state = value; 
		},
		break(seconds: number, policy: 'next-fit-only' | 'next-truncate' | 'best-fit-only' | 'best-fit-or-truncate' = 'next-fit-only', key = 'mid-roll') {
			const result = planFiller(program.id, { type: 'duration', seconds, policy }, state, context, key, 'UTC', 'break');
			state = result.state;
			return result;
		},
	};
}

it.each(['next-fit-only', 'best-fit-only', 'next-truncate', 'best-fit-or-truncate'] as const)('fills millisecond-exact windows with %s across budgets and selection strategies', policy => {
	for (const strategy of ['sequential', 'shuffle', 'random', 'weighted-random'] as const) {
		for (const budget of [
			{ type: 'duration', seconds: 60, policy }, { type: 'remaining', policy },
			{ type: 'count', count: 2 }, { type: 'random-count', minimum: 2, maximum: 2 },
		] satisfies FillerBudget[]) {
			const f = fixture([32.002, 27.998], strategy);
			const result = planFiller(f.program.id, budget, f.state, f.context, 'tail', 'UTC', 'exact', 60);
			expect(new Set(result.spans.map(span => span.media.id))).toEqual(new Set(f.media.map(item => item.id)));
			expect(result.durationSeconds).toBe(60);
			expect(result.progress.remaining).toBe(0);
			expect(result.spans.every(span => !span.truncated)).toBe(true);
			expect(result.state.get('tail')!.value.fillerCycle!.remainingItemIds).toEqual([]);
		}
	}
});

it.each(['next-fit-only', 'best-fit-only', 'next-truncate', 'best-fit-or-truncate'] as const)('respects one-millisecond shortages with %s and preserves unplayed state', policy => {
	const f = fixture([32.002, 27.998]);
	const result = planFiller(f.program.id, { type: 'remaining', policy }, f.state, f.context, 'tail', 'UTC', 'short', 59.999);
	const truncate = policy === 'next-truncate' || policy === 'best-fit-or-truncate';
	expect(result.durationSeconds).toBe(truncate ? 59.999 : 32.002);
	expect(result.spans.map(span => span.truncated)).toEqual(truncate ? [false, true] : [false]);
	expect(result.state.get('tail')!.value.fillerCycle!.remainingItemIds).toEqual(truncate ? [] : ['item-1']);
});

it('starts a filler cycle after an excluded item when restoring an older sequential cursor', () => {
	const f = fixture([30, 30, 30, 30]);
	const first = selectProgram(f.program.id, 'filler', f.state, f.context)!;
	const second = selectProgram(f.program.id, 'filler', first.state, f.context)!;
	expect(second.media.id).toBe('item-1');
	if (f.program.config.type !== 'content' || f.program.config.source.type !== 'collection') {
		throw new Error('Expected a collection');
	}
	const edited: SchedulingProgram = { ...f.program, config: { ...f.program.config,
		source: { ...f.program.config.source, exclusions: { itemIds: [second.media.id], groupIds: [] } } } };
	const context = { ...f.context, programs: new Map([[edited.id, edited]]), candidateCache: new Map() };
	const resumed = planFiller(edited.id, { type: 'count', count: 1 }, second.state, context, 'filler', 'UTC', 'break');
	expect(resumed.spans.map(span => span.media.id)).toEqual(['item-2']);
});

it('keeps fractional budgets exact after serialized continuation and repeated accumulation', () => {
	const f = fixture([0.001]);
	const budget = { type: 'duration', seconds: 1, policy: 'next-fit-only' } as const;
	const first = planFiller(f.program.id, budget, f.state, f.context, 'tail', 'UTC', 'continue', 0.102);
	expect(first.durationSeconds).toBe(0.102);
	expect(first.progress.remaining).toBe(0.898);
	const later = planFiller(
		f.program.id,
		budget,
		new Map(JSON.parse(JSON.stringify([...first.state]))),
		f.context,
		'tail',
		'UTC',
		'continue',
		0.898,
		JSON.parse(JSON.stringify(first.progress)),
	);
	expect(later.durationSeconds).toBe(0.898);
	expect(later.progress.remaining).toBe(0);
	expect(later.spans.every(span => !span.truncated)).toBe(true);
});

it.each(['first-fit-arbitrary', 'best-fit'] as const)('uses exact millisecond limits for %s primary and fallback candidates', mode => {
	for (const strictFirst of [false, true]) {
		for (const collision of [false, true]) {
			const f = fixture([40.102]);
			f.context.mediaDuration = () => 30.1 + 10.002;
			if (collision) {
				f.context.occupiedMedia = [{ mediaItemId: f.media[0]!.id, start: f.context.selectionStart, finish: '2026-01-01T01:00:00Z' }];
			}
			for (const avoidItemId of [null, f.media[0]!.id]) {
				expect(selectOrderedCandidate(f.media, f.context, 40.101, mode, strictFirst, avoidItemId)).toBeNull();
				expect(selectOrderedCandidate(f.media, f.context, 40.102, mode, strictFirst, avoidItemId)).toBe(f.media[0]);
				expect(selectOrderedCandidate(f.media, f.context, 40.103, mode, strictFirst, avoidItemId)).toBe(f.media[0]);
			}
		}
	}
});

it.each([false, true])('keeps touching occupancy boundaries exclusive with indexed=%s', indexed => {
	for (const selectionStart of ['1970-01-01T00:00:00Z', '2026-01-01T01:00:00+01:00']) {
		const f = fixture([40.102]);
		f.context.selectionStart = selectionStart;
		f.context.mediaDuration = () => 30.1 + 10.002;
		for (const offset of [-1, 0, 1]) {
			const start = Date.parse(selectionStart) + 40_102 + offset;
			f.context.occupiedMedia = [{ mediaItemId: f.media[0]!.id, start: new Date(start).toISOString(), finish: new Date(start + 1).toISOString() }];
			if (indexed) {
				f.context.occupiedMediaIndex = indexOccupiedMedia(f.context.occupiedMedia);
			}
			expect(hasSelectionCollision(f.media[0]!, f.context)).toBe(offset < 0);
		}
	}
});

it.each(['sequential', 'shuffle', 'random', 'weighted-random'] as const)('consumes %s filler without replacement and retains oversized positions across cycles', strategy => {
	const f = fixture([200, 30, 30], strategy);
	const first = f.break(60);
	expect(new Set(first.spans.map(span => span.media.id))).toEqual(new Set(['item-1', 'item-2']));
	expect(first.durationSeconds).toBe(60);
	const queue = f.state.get('mid-roll')!.value.fillerCycle!;
	expect(queue.remainingItemIds).toEqual(['item-0']);
	const snapshot = structuredClone(f.state);
	const second = f.break(60);
	expect(new Set(second.spans.map(span => span.media.id))).toEqual(new Set(['item-1', 'item-2']));
	expect(f.state.get('mid-roll')!.value.fillerCycle!.remainingItemIds).toEqual(['item-0']);
	expect(snapshot.get('mid-roll')!.value.fillerCycle!.cycle).toBeLessThan(f.state.get('mid-roll')!.value.fillerCycle!.cycle);
	const larger = f.break(200);
	expect(larger.spans.map(span => span.media.id)).toEqual(['item-0']);
});

it('resumes early when unplayed items fit the full budget but not the remaining gap', () => {
	const f = fixture([90, 60]);
	const first = f.break(120);
	expect(first.spans.map(span => span.media.id)).toEqual(['item-0']);
	expect(first.durationSeconds).toBe(90);
	const second = f.break(90);
	expect(second.spans.map(span => span.media.id)).toEqual(['item-1']);
	expect(second.durationSeconds).toBe(60);
	expect(f.state.get('mid-roll')!.value.fillerCycle!.remainingItemIds).toEqual([]);
});

it('keeps source ordering instead of repeatedly choosing the longest fit', () => {
	const f = fixture([30, 90, 60]);
	expect(f.break(120, 'best-fit-only').spans.map(span => span.media.id)).toEqual(['item-0', 'item-1']);
	expect(f.break(60, 'best-fit-only').spans.map(span => span.media.id)).toEqual(['item-2']);
});

it('bounds empty/all-oversized attempts and leaves rejected state untouched', () => {
	const f = fixture([200, 300]);
	const input = f.state;
	const before = structuredClone(input);
	expect(f.break(120).spans).toEqual([]);
	expect(input).toEqual(before);
	expect(f.state).toEqual(before);
	const truncated = f.break(120, 'next-truncate');
	expect(truncated.spans[0]).toMatchObject({ truncated: true, sourceFinishSeconds: 120 });
	expect(f.state.get('mid-roll')!.value.fillerCycle!.remainingItemIds).toEqual(['item-1']);
});

it('keeps stage queues independent and preserves consumed membership through serialization', () => {
	const f = fixture([30, 90]);
	expect(f.break(30).spans[0]!.media.id).toBe('item-0');
	f.state = new Map(JSON.parse(JSON.stringify([...f.state])));
	expect(f.break(90).spans[0]!.media.id).toBe('item-1');
	expect(f.break(30, 'next-fit-only', 'pre-roll').spans[0]!.media.id).toBe('item-0');
});

it('reconciles catalog removals and additions without replaying consumed members', () => {
	const f = fixture([30, 60, 90]);
	if (f.program.config.type === 'content') {
		f.program.config.source = { type: 'library-query', libraryId: 'library', kinds: [], genres: [] };
	}
	f.break(30);
	f.context.catalog.media = [f.media[0]!, f.media[2]!, { ...f.media[1]!, id: 'new', durationSeconds: 40 }];
	Object.assign(f.context.catalog, indexSchedulingCatalog(f.context.catalog));
	f.context.candidateCache.clear();
	const next = f.break(90);
	expect(next.spans.map(span => span.media.id)).toEqual(['item-2']);
	expect(next.state.get('mid-roll')!.value.fillerCycle!.remainingItemIds).toEqual(['new']);
});

it('preserves collision preference without spending the colliding queue position', () => {
	const f = fixture([30, 30, 200], 'shuffle');
	const colliding = f.break(30).spans[0]!.media.id;
	f.state = new Map();
	f.context.occupiedMedia = [{ mediaItemId: colliding, start: f.context.selectionStart, finish: '2026-01-01T01:00:00Z' }];
	f.context.occupiedMediaIndex = indexOccupiedMedia(f.context.occupiedMedia);
	expect(f.break(30).spans[0]!.media.id).not.toBe(colliding);
	expect(f.state.get('mid-roll')!.value.fillerCycle!.remainingItemIds).toContain(colliding);
});

it.each(['count', 'random-count', 'pad', 'remaining'] as const)('supports %s budgets without replacement', type => {
	const f = fixture([30, 30, 30]);
	const budget: FillerBudget = type === 'count' ? { type, count: 3 } : type === 'random-count' ? { type, minimum: 3, maximum: 3 }
		: type === 'pad' ? { type, minutes: 1, policy: 'next-fit-only' } : { type, policy: 'next-fit-only' };
	f.context.selectionStart = '2026-01-01T00:00:01Z';
	const result = planFiller(f.program.id, budget, f.state, f.context, 'tail', 'UTC', 'budget', 90);
	expect(new Set(result.spans.map(span => span.media.id)).size).toBe(result.spans.length);
	expect(result.spans.length).toBe(type === 'pad' ? 1 : 3);
});

it('does not change ordinary primary sequential fit rejection', () => {
	const f = fixture([200, 30]);
	expect(selectProgram(f.program.id, 'primary', f.state, f.context, 120, 'first-fit-arbitrary')).toBeNull();
	expect(f.state.size).toBe(0);
});

it('adopts existing sequential progress without replaying its consumed prefix', () => {
	const f = fixture([30, 30, 30]);
	const primary = selectProgram(f.program.id, 'mid-roll', f.state, f.context)!;
	f.state = primary.state;
	expect(f.state.get('mid-roll')!.value.fillerCycle).toBeUndefined();
	expect(f.break(60).spans.map(span => span.media.id)).toEqual(['item-1', 'item-2']);
});

it('adopts existing shuffle membership without restarting its cycle', () => {
	const f = fixture([30, 30, 30], 'shuffle');
	const prior = selectProgram(f.program.id, 'mid-roll', f.state, f.context)!;
	f.state = prior.state;
	const played = prior.media.id;
	expect(f.break(60).spans.map(span => span.media.id)).not.toContain(played);
});

it('retains original full-stage eligibility across a serialized continuation', () => {
	const f = fixture([30, 90]);
	const first = planFiller(f.program.id, { type: 'duration', seconds: 120, policy: 'next-fit-only' }, f.state, f.context, 'tail', 'UTC', 'continue', 30);
	// A continuation originating in a larger stage must not replace its capacity with the remainder.
	const progress = { unit: 'seconds' as const, remaining: 30, fullBudgetSeconds: 120 };
	const later = planFiller(f.program.id, { type: 'duration', seconds: 120, policy: 'next-fit-only' }, first.state, f.context, 'tail', 'UTC', 'continue', 30, JSON.parse(JSON.stringify(progress)));
	expect(later.spans).toEqual([]);
	expect(later.state).toEqual(first.state);
});

it('bounds candidate reads under substantial occupancy and shares untouched state records', () => {
	const f = fixture(Array.from({ length: 1000 }, (_, index) => index < 500 ? 200 : 30), 'shuffle');
	f.context.occupiedMedia = f.media.slice(500, 750).flatMap(media => Array.from({ length: 8 }, (_, index) => ({
		mediaItemId: media.id, start: `2026-01-01T0${index}:00:00Z`, finish: '2026-01-02T00:00:00Z',
	})));
	f.context.occupiedMediaIndex = indexOccupiedMedia(f.context.occupiedMedia);
	let reads = 0;
	for (const media of f.media) {
		const duration = media.durationSeconds;
		Object.defineProperty(media, 'durationSeconds', { get: () => {
			reads += 1;
			return duration;
		}, enumerable: true });
	}
	const other: SelectionStateRecord = { consumerKey: 'primary', configFingerprint: 'unchanged', updatedAt: f.context.now, value: { type: 'sequential', nextIndex: 42, lastItemId: null } };
	f.state.set(other.consumerKey, other);
	const result = f.break(120);
	expect(result.spans).toHaveLength(4);
	expect(reads).toBeLessThan(1000 * 4 * 8);
	expect(result.spans.every(span => Number(span.media.id.split('-')[1]) >= 750)).toBe(true);
	expect(result.state.get('primary')).toBe(other);
	expect(other.value).toMatchObject({ nextIndex: 42 });
});

it('canonicalizes saved queue aliases without replaying consumed media or duplicating deferred entries', () => {
	const f = fixture([200, 30, 30]);
	f.break(30);
	const cycle = f.state.get('mid-roll')!.value.fillerCycle!;
	cycle.itemIds = ['old-long', 'old-played', 'item-2'];
	cycle.remainingItemIds = ['old-long', 'item-0', 'item-2'];
	f.context.catalog.mediaAliases = { 'old-long': 'item-0', 'old-played': 'item-1' };
	const next = f.break(30);
	expect(next.spans.map(span => span.media.id)).toEqual(['item-2']);
	expect(next.state.get('mid-roll')!.value.fillerCycle!.remainingItemIds).toEqual(['item-0']);
});

it.each(['shuffle', 'weighted-random'] as const)('avoids preventable immediate %s repeats across cycle boundaries', strategy => {
	const f = fixture([30, 30], strategy);
	const played = Array.from({ length: 20 }, () => f.break(30).spans[0]!.media.id);
	expect(played.every((id, index) => index === 0 || id !== played[index - 1])).toBe(true);
});

it.each(['shuffle', 'random', 'weighted-random'] as const)('reproduces %s ordering across deferred cycles from the same seed', strategy => {
	const left = fixture([200, 30, 30, 30], strategy);
	const right = fixture([200, 30, 30, 30], strategy);
	const sequence = (f: ReturnType<typeof fixture>) => Array.from({ length: 12 }, () => f.break(60).spans.map(span => span.media.id));
	expect(sequence(left)).toEqual(sequence(right));
	expect(left.state).toEqual(right.state);
});

it('recovers full duration eligibility from older checkpoints without the optional capacity field', () => {
	const f = fixture([30, 90]);
	f.break(30);
	const older = { unit: 'seconds' as const, remaining: 30 };
	const result = planFiller(f.program.id, { type: 'duration', seconds: 120, policy: 'next-fit-only' }, f.state, f.context, 'mid-roll', 'UTC', 'legacy', 30, older);
	expect(result.spans).toEqual([]);
	expect(result.progress.fullBudgetSeconds).toBe(120);
	expect(result.state).toEqual(f.state);
});

function sequenceFixture(durations: number[], counts: number[], ordering: SequenceOrdering = { type: 'ordered' }, repeat = true) {
	const f = fixture(durations);
	const children: SchedulingProgram[] = f.media.map((item, index) => ({ ...f.program, id: `source-${index}`,
		config: { type: 'content', source: { type: 'item', itemId: item.id }, strategy: { type: 'sequential' } } }));
	for (const child of children) {
		f.context.programs.set(child.id, child);
	}
	const config = { type: 'sequence', ordering, repeat,
		entries: children.map((child, index) => ({ id: `entry-${index}`, programId: child.id, count: counts[index]! })) } as const;
	const root: SchedulingProgram = { ...f.program, config };
	f.context.programs.set(root.id, root);
	return { ...f, root, config, children, get state() {
		return f.state;
	}, set state(value: Map<string, SelectionStateRecord>) {
		f.state = value;
	} };
}

it.each([
	[[1, 1, 1, 1], [0, 1, 2, 3]],
	[[3, 1, 1, 1], [0, 1, 0, 2, 3, 0]],
])('disperses %j in a balanced rotation across one-item breaks', (counts, cycle) => {
	const f = sequenceFixture([30, 30, 30, 30], counts, { type: 'balanced-rotation' });
	const played = Array.from({ length: cycle.length * 2 }, () => f.break(30).spans[0]!.media.id);
	expect(played.slice(0, cycle.length)).toEqual(cycle.map(index => f.media[index]!.id));
	expect(played.slice(cycle.length).sort()).toEqual(cycle.map(index => f.media[index]!.id).sort());
	expect(played.every((id, index) => index === 0 || id !== played[index - 1])).toBe(true);
	expect(f.break(30, 'next-fit-only', 'another-stage').spans[0]?.media.id).toBe(f.media[0]!.id);
});

it('continues short categories while carrying only one allocation of an oversized category', () => {
	const f = sequenceFixture([90, 30], [2, 1]);
	for (let index = 0; index < 4; index += 1) {
		expect(f.break(30).spans.map(span => span.media.id)).toEqual(['item-1']);
	}
	const before = structuredClone(f.state);
	expect(f.break(180).spans.map(span => span.media.id)).toEqual(['item-0', 'item-0']);
	expect(f.state.get('mid-roll:entry:entry-0')).toBeDefined();
	expect(before.get('mid-roll:entry:entry-0')).toBeUndefined();
});

it('does not refill when a pending turn fits the full break but exceeds the remainder', () => {
	const f = sequenceFixture([25, 40], [1, 1]);
	expect(f.break(50).spans.map(span => span.media.id)).toEqual(['item-0']);
	expect(f.break(50).spans.map(span => span.media.id)).toEqual(['item-1']);
});

it('gives a skipped turn priority over the active rotation once it fits', () => {
	const f = sequenceFixture([90, 30, 30], [1, 3, 1], { type: 'balanced-rotation' });
	expect(f.break(30).spans.map(span => span.media.id)).toEqual(['item-1']);
	expect(f.break(30).spans.map(span => span.media.id)).toEqual(['item-2']);
	expect(f.break(90).spans.map(span => span.media.id)).toEqual(['item-0']);
});

it('looks through nested Sequences for a whole clip before truncating a pending turn', () => {
	const f = sequenceFixture([80, 30], [1, 1], { type: 'ordered' }, false);
	const nested: SchedulingProgram = { ...f.root, id: 'nested', config: { ...f.config, entries: [{ ...f.config.entries[0]! }] } };
	f.context.programs.set(nested.id, nested);
	f.config.entries[0]!.programId = nested.id;

	const first = f.break(30, 'next-truncate');
	expect(first.spans.map(span => [span.media.id, span.truncated, span.sequenceEntryPath])).toEqual([['item-1', false, ['entry-1']]]);
	const next = f.break(30, 'next-truncate');
	expect(next.spans.map(span => [span.media.id, span.truncated, span.sequenceEntryPath])).toEqual([['item-0', true, ['entry-0', 'entry-0']]]);
	expect(f.break(90).spans).toEqual([]);
});

it('bounds whole-clip searches across repeated nested references before considering truncation', () => {
	const f = sequenceFixture([80], [1]);
	let child = f.children[0]!.id;
	for (let depth = 0; depth <= Math.ceil(Math.log2(SEQUENCE_FILLER_PROBE_LIMIT)); depth += 1) {
		const nested: SchedulingProgram = { ...f.root, id: `nested-${depth}`, config: { type: 'sequence', repeat: false,
			entries: ['first', 'second'].map(id => ({ id, programId: child, count: 1 })) } };
		f.context.programs.set(nested.id, nested);
		child = nested.id;
	}
	f.config.entries[0]!.programId = child;
	expect(f.break(30, 'next-truncate').spans).toEqual([]);
	expect(f.state.size).toBe(0);
	expect(f.context.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'source-unavailable', programId: f.root.id })]));
	expect(f.break(80).spans.map(span => span.media.id)).toEqual(['item-0']);
});

it('skips unavailable Sequence children and retains the source diagnostic', () => {
	const f = sequenceFixture([30, 30], [1, 1], { type: 'ordered' }, false);
	f.context.programs.delete(f.children[0]!.id);
	expect(f.break(30).spans.map(span => span.media.id)).toEqual(['item-1']);
	expect(f.context.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'program-missing' })]));
});

it('resumes an older Ordered tail cursor at the same turn', () => {
	const f = sequenceFixture([30, 30], [1, 1]);
	const before = selectProgram(f.root.id, 'mid-roll', f.state, f.context)!;
	expect(before.media.id).toBe('item-0');
	f.state = before.state;
	expect(f.break(30).spans.map(span => span.media.id)).toEqual(['item-1']);
});

it('retains rolled filler turns across fit retries and serialized continuation', () => {
	const f = sequenceFixture([80, 30, 30], [100, 30, 0], { type: 'chance', seed: 'ad-demo' }, false);
	const first = f.break(30);
	expect(first.spans.map(span => span.media.id)).toEqual(['item-1']);
	const before = structuredClone(f.state);
	expect(f.break(30).spans).toEqual([]);
	expect(f.state).toEqual(before);
	f.state = new Map(JSON.parse(JSON.stringify([...f.state])));
	expect(f.break(80).spans.map(span => span.media.id)).toEqual(['item-0']);
	expect(f.break(80).spans).toEqual([]);
});

it('returns independent initial and final progress for partial stage commitment', () => {
	const f = fixture([30, 90]);
	const result = f.break(120);
	expect(result.initialProgress).toEqual({ unit: 'seconds', remaining: 120, fullBudgetSeconds: 120 });
	expect(result.progress.remaining).toBe(0);
	result.progress.remaining = 42;
	expect(result.initialProgress.remaining).toBe(120);
});


it.each(['sequential', 'shuffle', 'random', 'weighted-random'] as const)('applies the leaf %s collision policy to filler and preserves fit behavior', strategy => {
	const f = fixture([90, 30, 30], strategy);
	const baseline = f.break(30);
	const selectedId = baseline.spans[0]!.media.id;
	f.state = new Map();
	f.context.occupiedMedia = [{ mediaItemId: selectedId, start: f.context.selectionStart, finish: '2026-01-01T01:00:00Z' }];
	const avoided = f.break(30);
	if (strategy === 'sequential') {
		expect(avoided.spans[0]!.media.id).toBe(selectedId);
	}
	else {
		expect(avoided.spans[0]!.media.id).not.toBe(selectedId);
	}
	f.state = new Map();
	f.context.avoidCrossChannelDuplicates = false;
	expect(f.break(30).spans.map(span => span.media.id)).toEqual(baseline.spans.map(span => span.media.id));
});
