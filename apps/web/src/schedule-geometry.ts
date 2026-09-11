import {
	SECONDS_PER_SCHEDULING_DAY,
	type ScheduleBoundary,
	type ScheduleSlot,
	type ScheduleTemplateCreate,
} from '@moirai/shared';
import { randomUuid } from './random-uuid';

/** Factory used to assign identities when a slot is split. */
export type IdFactory = () => string;

/** Fifteen-minute editor increment used for slot placement and boundary movement. */
export const SLOT_PLACEMENT_STEP_SECONDS = 15 * 60;
/** Bound schedule geometry resource use for placed slot seconds. */
export const MIN_PLACED_SLOT_SECONDS = SLOT_PLACEMENT_STEP_SECONDS;

/** Slot plus its normalized start and end positions in a nominal day. */
export interface SlotPlacement {
	slotId: string;
	splitSeconds: number;
}

/** Return template slots in nominal start-time order. */
function orderedSlots(slots: ScheduleSlot[]): ScheduleSlot[] {
	return [...slots].sort((left, right) => left.startSeconds - right.startSeconds);
}

/** Resolve a slot end from its explicit adjacent boundary. */
function nominalSlotEnd(slots: ScheduleSlot[], index: number): number {
	return slots[index + 1]?.startSeconds ?? SECONDS_PER_SCHEDULING_DAY;
}

/** Return a valid snapped split within one slot, leaving useful time on both sides. */
export function slotPlacementForTime(
	template: ScheduleTemplateCreate,
	slotId: string,
	desiredSeconds: number,
): SlotPlacement | null {
	const slots = orderedSlots(template.slots);
	const index = slots.findIndex((slot) => slot.id === slotId);
	const slot = slots[index];
	if (!slot) {
		return null;
	}

	const end = nominalSlotEnd(slots, index);
	const splitSeconds
		= Math.round(desiredSeconds / SLOT_PLACEMENT_STEP_SECONDS) * SLOT_PLACEMENT_STEP_SECONDS;
	if (
		splitSeconds < slot.startSeconds + MIN_PLACED_SLOT_SECONDS
		|| splitSeconds > end - MIN_PLACED_SLOT_SECONDS
	) {
		return null;
	}

	return { slotId, splitSeconds };
}

/** Resolve a pointer time to a valid snapped slot split. */
export function timelineSlotPlacement(
	template: ScheduleTemplateCreate,
	desiredSeconds: number,
): SlotPlacement | null {
	const slots = orderedSlots(template.slots);
	const slot = slots.find((entry, index) => {
		const end = nominalSlotEnd(slots, index);
		return desiredSeconds >= entry.startSeconds && desiredSeconds <= end;
	});
	return slot ? slotPlacementForTime(template, slot.id, desiredSeconds) : null;
}

/** Choose the nearest snapped midpoint used when placement starts from the keyboard. */
export function midpointSlotPlacement(
	template: ScheduleTemplateCreate,
	slotId: string,
): SlotPlacement | null {
	const slots = orderedSlots(template.slots);
	const index = slots.findIndex((slot) => slot.id === slotId);
	const slot = slots[index];
	if (!slot) {
		return null;
	}

	const end = nominalSlotEnd(slots, index);
	return slotPlacementForTime(template, slot.id, slot.startSeconds + (end - slot.startSeconds) / 2);
}

/** Reconnect outgoing boundaries to match the current contiguous slot order. */
export function rebuildBoundaries(
	slots: ScheduleSlot[],
	boundaries: ScheduleBoundary[],
	createId: IdFactory = randomUuid,
): ScheduleBoundary[] {
	const ordered = orderedSlots(slots);
	const byLeft = new Map(boundaries.map((boundary) => [boundary.leftSlotId, boundary]));
	return ordered.map((slot, index) => {
		const right = ordered[(index + 1) % ordered.length]!;
		const existing = byLeft.get(slot.id);
		return {
			id: existing?.id ?? createId(),
			leftSlotId: slot.id,
			rightSlotId: right.id,
			targetSeconds: index === ordered.length - 1 ? SECONDS_PER_SCHEDULING_DAY : right.startSeconds,
			policy: existing?.policy ?? 'hard',
			maxDriftSeconds: existing?.maxDriftSeconds ?? 0,
			fallback: existing?.fallback ?? 'reject-start',
			earlyStartMaxDriftSeconds: existing?.earlyStartMaxDriftSeconds ?? 0,
		};
	});
}

/** Split one slot while preserving a contiguous full-day template. */
export function splitScheduleSlot(
	template: ScheduleTemplateCreate,
	slotId: string,
	splitSeconds: number,
	createId: IdFactory = randomUuid,
): ScheduleTemplateCreate {
	const slots = orderedSlots(template.slots);
	const index = slots.findIndex((slot) => slot.id === slotId);
	const slot = slots[index];
	if (!slot) {
		return template;
	}

	const end
		= index === slots.length - 1 ? SECONDS_PER_SCHEDULING_DAY : slots[index + 1]!.startSeconds;
	if (splitSeconds <= slot.startSeconds || splitSeconds >= end) {
		return template;
	}

	const outgoing = template.boundaries.find((boundary) => boundary.leftSlotId === slot.id);
	const right: ScheduleSlot = {
		...slot,
		id: createId(),
		startSeconds: splitSeconds,
		...(slot.guide ? { guide: { ...slot.guide } } : {}),
		startEligibility: { ...slot.startEligibility },
		filler: slot.filler.mode === 'configured'
			? { mode: 'configured', config: { ...slot.filler.config } }
			: { ...slot.filler },
	};
	const nextSlots = orderedSlots([...slots, right]);
	const preserved = template.boundaries
		.filter((boundary) => boundary.leftSlotId !== slot.id)
		.concat({
			id: createId(),
			leftSlotId: slot.id,
			rightSlotId: right.id,
			targetSeconds: splitSeconds,
			policy: 'hard',
			maxDriftSeconds: 0,
			fallback: 'reject-start',
			earlyStartMaxDriftSeconds: 0,
		});
	if (outgoing) {
		preserved.push({ ...outgoing, leftSlotId: right.id });
	}
	return {
		...template,
		slots: nextSlots,
		boundaries: rebuildBoundaries(nextSlots, preserved, createId),
	};
}

/** Remove a slot and expand an adjacent slot to keep the day fully allocated. */
export function deleteScheduleSlot(
	template: ScheduleTemplateCreate,
	slotId: string,
	createId: IdFactory = randomUuid,
): ScheduleTemplateCreate {
	const slots = orderedSlots(template.slots);
	if (slots.length <= 1) {
		return template;
	}

	const index = slots.findIndex((slot) => slot.id === slotId);
	if (index < 0) {
		return template;
	}

	const removed = slots[index]!;
	const nextSlots = slots.filter((slot) => slot.id !== slotId).map((slot) => ({ ...slot }));
	const preserved = template.boundaries.filter(
		(boundary) => boundary.leftSlotId !== slotId && boundary.rightSlotId !== slotId,
	);
	if (index === 0) {
		const last = slots[slots.length - 1]!;
		const midnight = template.boundaries.find((boundary) => boundary.leftSlotId === last.id);
		nextSlots[0]!.startSeconds = 0;
		if (midnight) {
			preserved.push({ ...midnight, rightSlotId: nextSlots[0]!.id });
		}
	}
	else {
		const previous = slots[index - 1]!;
		const outgoing = template.boundaries.find((boundary) => boundary.leftSlotId === removed.id);
		const next = slots[(index + 1) % slots.length]!;
		if (outgoing) {
			preserved.push({ ...outgoing, leftSlotId: previous.id, rightSlotId: next.id });
		}
	}
	return {
		...template,
		slots: orderedSlots(nextSlots),
		boundaries: rebuildBoundaries(nextSlots, preserved, createId),
	};
}

/** Move a shared boundary while preserving ordered, non-overlapping slots. */
export function moveScheduleBoundary(
	template: ScheduleTemplateCreate,
	rightSlotId: string,
	targetSeconds: number,
): ScheduleTemplateCreate {
	const slots = orderedSlots(template.slots).map((slot) => ({ ...slot }));
	const index = slots.findIndex((slot) => slot.id === rightSlotId);
	if (index <= 0) {
		return template;
	}

	const minimum = slots[index - 1]!.startSeconds + 60;
	const maximum = (slots[index + 1]?.startSeconds ?? SECONDS_PER_SCHEDULING_DAY) - 60;
	slots[index]!.startSeconds = Math.max(minimum, Math.min(maximum, targetSeconds));
	return { ...template, slots, boundaries: rebuildBoundaries(slots, template.boundaries) };
}
