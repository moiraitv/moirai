import { expect, it } from 'vitest';
import { BUILTIN_MID_ROLL_PRESETS, BUILTIN_FILLER_PRESETS, MAX_MID_ROLL_POINTS, type AnyFillerPreset } from '@moirai/shared';
import { effectiveFillerAssignments, EXAMPLE_MOVIE_SECONDS, simulateFiller } from '@web/filler-simulation';

const preset: AnyFillerPreset = { ...BUILTIN_MID_ROLL_PRESETS[0]!, kind: 'mid-roll', isBuiltin: true, createdAt: '', updatedAt: '' };
const assignment = { programId: 'source', presetId: preset.id };

it('shows all inactive stages and preserves 137 minutes of source content', () => {
	const spans = simulateFiller({}, []);
	expect(spans.filter(span => span.kind === 'content').reduce((sum, span) => sum + span.seconds, 0)).toBe(EXAMPLE_MOVIE_SECONDS);
	expect(spans.filter(span => span.kind !== 'content').map(span => [span.kind, span.active])).toEqual([
		['pre-roll', false], ['mid-roll', false], ['post-roll', false], ['tail', false],
	]);
});

it('uses the selected interval, budget and guided predicate for mid-roll breaks', () => {
	const spans = simulateFiller({ 'mid-roll': assignment }, [preset]);
	const breaks = spans.filter(span => span.kind === 'mid-roll');
	expect(breaks).toHaveLength(13);
	expect(breaks[0]).toMatchObject({ point: 600, seconds: 120, active: true });
	expect(breaks.at(-1)?.point).toBe(7800);
	const alternate: AnyFillerPreset = { ...preset, fallbackIntervalSeconds: 1200, budget: { type: 'count', count: 2 },
		predicate: { type: 'every-nth', interval: 2, remainder: 0, negated: false } };
	expect(simulateFiller({ 'mid-roll': assignment }, [alternate]).filter(span => span.kind === 'mid-roll').map(span => [span.point, span.seconds])).toEqual([[2400, 60], [4800, 60], [7200, 60]]);
});

it('does not invent matching chapters for a chapter-title rule and caps timed candidates', () => {
	const titled: AnyFillerPreset = { ...preset, predicate: { type: 'title', value: 'Credits', negated: false } };
	expect(simulateFiller({ 'mid-roll': assignment }, [titled]).filter(span => span.kind === 'mid-roll')).toEqual([]);
	const frequent: AnyFillerPreset = { ...preset, fallbackIntervalSeconds: 1, predicate: { type: 'always', negated: false } };
	expect(simulateFiller({ 'mid-roll': assignment }, [frequent]).filter(span => span.kind === 'mid-roll')).toHaveLength(MAX_MID_ROLL_POINTS);
});

it('resolves inherited, disabled and configured types independently and supports legacy tail assignments', () => {
	const result = effectiveFillerAssignments({ 'pre-roll': assignment, 'mid-roll': assignment, tail: { programId: 'tail', policy: 'best-fit-only' } }, {
		'pre-roll': { mode: 'disabled' }, 'mid-roll': { mode: 'inherit' }, 'post-roll': { mode: 'configured', config: assignment },
	});
	expect(result['pre-roll']).toBeNull();
	expect(result['mid-roll']).toEqual(assignment);
	expect(result['post-roll']).toEqual(assignment);
	expect(result.tail?.presetId).toBe(BUILTIN_FILLER_PRESETS.find(value => value.kind === 'tail' && value.budget.type === 'remaining' && value.budget.policy === 'best-fit-only')?.id);
});

it('calculates clock padding after earlier filler and uses a bounded illustrative random quantity', () => {
	const pre: AnyFillerPreset = { ...preset, id: 'pre', kind: 'pre-roll', budget: { type: 'random-count', minimum: 1, maximum: 3 } };
	const post: AnyFillerPreset = { ...preset, id: 'post', kind: 'post-roll', budget: { type: 'pad', minutes: 15, policy: 'best-fit-only' } };
	const spans = simulateFiller({ 'pre-roll': { ...assignment, presetId: pre.id }, 'post-roll': { ...assignment, presetId: post.id } }, [pre, post]);
	expect(spans.find(span => span.kind === 'pre-roll')?.seconds).toBe(60);
	expect(spans.find(span => span.kind === 'post-roll')?.seconds).toBe(540);
});
