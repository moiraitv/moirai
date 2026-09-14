import { describe, expect, it } from 'vitest';
import { reactive } from 'vue';
import { DEFAULT_TEMPLATE_BOUNDARY_BEHAVIOR, SECONDS_PER_SCHEDULING_DAY, type ScheduleTemplateCreate } from '@moirai/shared';
import {
	deleteScheduleSlot,
	midpointSlotPlacement,
	moveScheduleBoundary,
	rebuildBoundaries,
	slotPlacementForTime,
	splitScheduleSlot,
	timelineSlotPlacement,
} from '@web/schedule-geometry';

const ids = ['slot-b', 'boundary-new'];
const createId = () => ids.shift() ?? 'generated';
const initial = (): ScheduleTemplateCreate => ({
	name: 'Daily',
	period: 'day',
	defaultFiller: null,
	slots: [
		{
			id: 'slot-a',
			startSeconds: 0,
			programId: 'program-a',
			stateScope: 'persistent',
			startEligibility: { type: 'require-fit' },
			filler: { mode: 'inherit' },
		},
	],
	boundaries: [
		{
			id: 'boundary-a',
			leftSlotId: 'slot-a',
			rightSlotId: 'slot-a',
			targetSeconds: SECONDS_PER_SCHEDULING_DAY,
			policy: 'finish-left',
			maxDriftSeconds: 900,
			fallback: 'reject-start',
		},
	],
});

describe('schedule geometry', () => {
	it('splits reactive editor state without cloning a Vue proxy', () => {
		const template = reactive(initial());
		expect(splitScheduleSlot(template, template.slots[0]!.id, 12 * 3_600).slots).toHaveLength(2);
	});

	it('splits a slot while preserving the former outgoing boundary on the new right slot', () => {
		const splitAt = 6 * 3_600;
		const result = splitScheduleSlot(initial(), 'slot-a', splitAt, createId);

		expect(result.slots.map((slot) => slot.startSeconds)).toEqual([0, splitAt]);
		expect(result.boundaries.find((boundary) => boundary.leftSlotId === 'slot-a')).toMatchObject({
			targetSeconds: splitAt,
			...DEFAULT_TEMPLATE_BOUNDARY_BEHAVIOR,
		});
		expect(result.boundaries.find((boundary) => boundary.leftSlotId === 'slot-b')).toMatchObject({
			targetSeconds: SECONDS_PER_SCHEDULING_DAY,
			policy: 'finish-left',
			maxDriftSeconds: 900,
		});
	});

	it('preserves unlimited drift through splitting, moving, and deleting slots', () => {
		const template = initial();
		template.boundaries[0]!.maxDriftSeconds = null;
		const split = splitScheduleSlot(template, 'slot-a', SECONDS_PER_SCHEDULING_DAY / 2);
		const right = split.slots[1]!;
		const moved = moveScheduleBoundary(split, right.id, SECONDS_PER_SCHEDULING_DAY / 3);
		const deleted = deleteScheduleSlot(moved, right.id);

		for (const result of [split, moved, deleted]) {
			expect(result.boundaries.every(boundary => boundary.maxDriftSeconds === null)).toBe(true);
		}
		expect(deleted.boundaries[0]!.id).toBe(template.boundaries[0]!.id);
	});

	it('uses authoring defaults only for missing boundaries', () => {
		const template = initial();
		expect(rebuildBoundaries(template.slots, [])[0]).toMatchObject(DEFAULT_TEMPLATE_BOUNDARY_BEHAVIOR);
		template.boundaries[0]!.policy = 'hard';
		template.boundaries[0]!.maxDriftSeconds = 0;
		expect(rebuildBoundaries(template.slots, template.boundaries)[0]).toMatchObject(template.boundaries[0]!);
	});

	it('snaps timeline placement to fifteen minutes within the containing slot', () => {
		const template = splitScheduleSlot(initial(), 'slot-a', 8 * 3_600, () => crypto.randomUUID());
		const right = template.slots.find((slot) => slot.startSeconds > 0)!;

		expect(timelineSlotPlacement(template, 10 * 3_600 + 8 * 60)).toEqual({
			slotId: right.id,
			splitSeconds: 10 * 3_600 + 15 * 60,
		});
	});

	it('requires fifteen minutes on each side of a placed boundary', () => {
		expect(slotPlacementForTime(initial(), 'slot-a', 5 * 60)).toBeNull();
		expect(slotPlacementForTime(initial(), 'slot-a', 15 * 60)).toEqual({
			slotId: 'slot-a',
			splitSeconds: 15 * 60,
		});
		const short = splitScheduleSlot(initial(), 'slot-a', 15 * 60, () => crypto.randomUUID());
		expect(midpointSlotPlacement(short, 'slot-a')).toBeNull();
	});

	it('moves only an interior nominal boundary', () => {
		const split = splitScheduleSlot(initial(), 'slot-a', 6 * 3_600, () => crypto.randomUUID());
		const right = split.slots.find((slot) => slot.startSeconds > 0)!;
		const moved = moveScheduleBoundary(split, right.id, 7 * 3_600 + 30 * 60);

		expect(moved.slots.find((slot) => slot.id === right.id)?.startSeconds).toBe(
			7 * 3_600 + 30 * 60,
		);
		expect(
			moved.boundaries.find((boundary) => boundary.leftSlotId === 'slot-a')?.targetSeconds,
		).toBe(7 * 3_600 + 30 * 60);
	});

	it('returns a split template to one valid midnight-wrapped slot after deletion', () => {
		const split = splitScheduleSlot(initial(), 'slot-a', 12 * 3_600, () => crypto.randomUUID());
		const right = split.slots.find((slot) => slot.startSeconds > 0)!;
		const result = deleteScheduleSlot(split, right.id, () => crypto.randomUUID());

		expect(result.slots).toHaveLength(1);
		expect(result.boundaries).toHaveLength(1);
		expect(result.boundaries[0]).toMatchObject({
			leftSlotId: 'slot-a',
			rightSlotId: 'slot-a',
			targetSeconds: SECONDS_PER_SCHEDULING_DAY,
		});
	});
});

it('copies guide settings independently when dividing a slot', () => {
	const template = reactive(initial());
	template.slots[0]!.guide = { mode: 'block', title: 'Music', description: '', boundary: 'scheduled' };
	const result = splitScheduleSlot(template, 'slot-a', SECONDS_PER_SCHEDULING_DAY / 2);
	const right = result.slots[1]!.guide;
	expect(right).toEqual(template.slots[0]!.guide);
	if (right?.mode === 'block') {
		right.title = 'Rock Music';
	}
	expect(template.slots[0]!.guide.title).toBe('Music');
});
