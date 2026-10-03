import { expect, it } from 'vitest';
import { clockPaddingSeconds, randomFillerCount } from '@server/scheduling/filler-plan.js';
import { fillerPresetCreateSchema, midRollSettingsSchema, DEFAULT_MID_ROLL_PREDICATE } from '@moirai/shared';

it('pads to local clock boundaries and needs no filler exactly on a boundary', () => {
	expect(clockPaddingSeconds('2026-01-01T12:07:30Z', 'UTC', 15)).toBe(450);
	expect(clockPaddingSeconds('2026-01-01T12:15:00Z', 'UTC', 15)).toBe(0);
	expect(clockPaddingSeconds('2026-01-01T12:15:00.001Z', 'UTC', 15)).toBeCloseTo(899.999);
	expect(clockPaddingSeconds('2026-01-01T12:07:30Z', 'Asia/Kathmandu', 30)).toBe(450);
});
it('finds chronological boundaries through skipped and repeated DST hours', () => {
	expect(clockPaddingSeconds('2026-03-08T09:59:30Z', 'America/Los_Angeles', 60)).toBe(30);
	expect(clockPaddingSeconds('2026-11-01T08:59:30Z', 'America/Los_Angeles', 60)).toBe(30);
	expect(clockPaddingSeconds('2026-11-01T09:15:01Z', 'America/Los_Angeles', 30)).toBe(899);
});
it('samples inclusive reproducible quantities, including zero and both endpoints', () => {
	const counts = Array.from({ length: 100 }, (_, index) => randomFillerCount(0, 4, `break:${index}`));
	expect(new Set(counts)).toEqual(new Set([0, 1, 2, 3, 4]));
	expect(randomFillerCount(2, 2, 'same')).toBe(2);
	expect(randomFillerCount(0, 4, 'same')).toBe(randomFillerCount(0, 4, 'same'));
});
it('rejects reversed random bounds and non-tail remaining-slot budgets', () => {
	const preset = { kind: 'pre-roll', name: 'Introduction', budget: { type: 'random-count', minimum: 4, maximum: 1 } };
	expect(fillerPresetCreateSchema.safeParse(preset).success).toBe(false);
	expect(fillerPresetCreateSchema.safeParse({ ...preset, budget: { type: 'remaining' } }).success).toBe(false);
	expect(fillerPresetCreateSchema.safeParse({ ...preset, kind: 'tail', budget: { type: 'remaining' } }).success).toBe(true);
	expect(midRollSettingsSchema.safeParse({ fallbackIntervalSeconds: 600, predicate: DEFAULT_MID_ROLL_PREDICATE, budget: { type: 'remaining' } }).success).toBe(false);
});

