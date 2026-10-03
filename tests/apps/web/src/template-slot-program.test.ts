import { expect, it } from 'vitest';
import { reactive } from 'vue';
import type { ScheduleSlot, SlotMidRoll } from '@moirai/shared';
import { setSlotProgram } from '@web/template-slot-program';

function slot(midRoll: SlotMidRoll): ScheduleSlot {
	return reactive({ id: 'slot', startSeconds: 0, programId: 'first-program', stateScope: 'persistent',
		startEligibility: { type: 'require-fit' }, filler: { mode: 'disabled' }, midRoll });
}

it.each<SlotMidRoll>([
	{ mode: 'inherit' },
	{ mode: 'disabled' },
	{ mode: 'configured', config: { programId: 'filler-program', presetId: 'preset' } },
])('preserves $mode mid-roll and disabled tail filler between primary Programs', (midRoll) => {
	const draft = slot(midRoll);
	const original = draft.midRoll;
	setSlotProgram(draft, 'second-program');

	expect(draft.programId).toBe('second-program');
	expect(draft.midRoll).toBe(original);
	expect(draft.midRoll).toEqual(midRoll);
	expect(draft.filler).toEqual({ mode: 'disabled' });
});

it('disables filler for fall-through and restores inheritance when assigning a Program', () => {
	const draft = slot({ mode: 'configured', config: { programId: 'filler-program', presetId: 'preset' } });
	setSlotProgram(draft, null);
	expect(draft).toMatchObject({ programId: null, filler: { mode: 'disabled' }, midRoll: { mode: 'disabled' } });

	setSlotProgram(draft, 'second-program');
	expect(draft).toMatchObject({ programId: 'second-program', filler: { mode: 'inherit' }, midRoll: { mode: 'inherit' } });
});
