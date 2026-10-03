import { expect, it } from 'vitest';
import type { FillerBudget, SchedulableMedia, SchedulingProgram, SelectionStateRecord } from '@moirai/shared';
import { planFiller } from '@server/scheduling/filler-plan.js';
import { indexSchedulingCatalog } from '@server/scheduling/catalog.js';
import { indexOccupiedMedia, selectProgram, type SelectionContext } from '@server/scheduling/selection.js';

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
	const f = fixture([30, 30, 200]);
	f.context.occupiedMedia = [{ mediaItemId: 'item-0', start: f.context.selectionStart, finish: '2026-01-01T01:00:00Z' }];
	f.context.occupiedMediaIndex = indexOccupiedMedia(f.context.occupiedMedia);
	expect(f.break(30).spans[0]!.media.id).toBe('item-1');
	expect(f.state.get('mid-roll')!.value.fillerCycle!.remainingItemIds).toContain('item-0');
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

it('rejects Sequence filler before planning, including a zero-item random budget', () => {
	const f = fixture();
	const sequence: SchedulingProgram = { ...f.program, config: { type: 'sequence', repeat: true,
		entries: [{ id: 'entry', programId: 'unused', count: 1 }] } };
	f.context.programs.set(sequence.id, sequence);
	expect(() => f.break(60)).toThrow('Sequence Programs cannot be used as filler');
	expect(() => planFiller(sequence.id, { type: 'random-count', minimum: 0, maximum: 0 }, f.state, f.context, 'filler', 'UTC', 'zero')).toThrow('Sequence Programs');
	f.context.fillerSelection = { fullBudgetSeconds: 60, allowTruncation: false };
	expect(() => selectProgram(sequence.id, 'filler', f.state, f.context)).toThrow('Sequence Programs');
	expect(f.state.size).toBe(0);
});

it('returns independent initial and final progress for partial stage commitment', () => {
	const f = fixture([30, 90]);
	const result = f.break(120);
	expect(result.initialProgress).toEqual({ unit: 'seconds', remaining: 120, fullBudgetSeconds: 120 });
	expect(result.progress.remaining).toBe(0);
	result.progress.remaining = 42;
	expect(result.initialProgress.remaining).toBe(120);
});
