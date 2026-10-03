import type { ScheduleSlot } from '@moirai/shared';

/** Preserve filler choices between Programs and normalize them on fall-through transitions. */
export function setSlotProgram(slot: ScheduleSlot, programId: string | null): void {
	const wasFallThrough = slot.programId === null;
	slot.programId = programId;

	if (programId === null) {
		slot.filler = { mode: 'disabled' };
		slot.midRoll = { mode: 'disabled' };
		slot.preRoll = { mode: 'disabled' };
		slot.postRoll = { mode: 'disabled' };
	}
	else if (wasFallThrough) {
		slot.filler = { mode: 'inherit' };
		slot.midRoll = { mode: 'inherit' };
		slot.preRoll = { mode: 'inherit' };
		slot.postRoll = { mode: 'inherit' };
	}
}
