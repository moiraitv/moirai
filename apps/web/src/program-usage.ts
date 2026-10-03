import type { SchedulingOverview } from '@moirai/shared';

/** Count every authored reference that prevents a scheduling program from being deleted. */
export function countProgramUsages(overview: SchedulingOverview | null): Map<string, number> {
	const counts = new Map<string, number>();
	const countUse = (programId: string) => {
		counts.set(programId, (counts.get(programId) ?? 0) + 1);
	};
	for (const template of overview?.templates ?? []) {
		for (const config of [template.defaultPreRoll, template.defaultPostRoll]) {
			if (config) {
				countUse(config.programId);
			}
		}
		if (template.defaultMidRoll) {
			countUse(template.defaultMidRoll.programId);
		}
		if (template.defaultFiller) {
			countUse(template.defaultFiller.programId);
		}
		for (const slot of template.slots) {
			if (slot.programId !== null) {
				countUse(slot.programId);
			}
			for (const rule of [slot.preRoll, slot.postRoll]) {
				if (rule?.mode === 'configured') {
					countUse(rule.config.programId);
				}
			}
			if (slot.midRoll?.mode === 'configured') {
				countUse(slot.midRoll.config.programId);
			}
			if (slot.filler.mode === 'configured') {
				countUse(slot.filler.config.programId);
			}
		}
	}
	for (const schedule of overview?.channelSchedules ?? []) {
		if (schedule.defaultProgramId) {
			countUse(schedule.defaultProgramId);
		}
		for (const layer of schedule.layers) {
			if (layer.programId) {
				countUse(layer.programId);
			}
		}
		for (const config of [schedule.defaultPreRoll, schedule.defaultPostRoll, schedule.defaultTailFiller]) {
			if (config) {
				countUse(config.programId);
			}
		}
		if (schedule.defaultMidRoll) {
			countUse(schedule.defaultMidRoll.programId);
		}
		if (schedule.defaultFiller) {
			countUse(schedule.defaultFiller.programId);
		}
	}
	for (const program of overview?.programs ?? []) {
		if (program.config.type === 'similarity') {
			countUse(program.config.sourceProgramId);
		}
		if (program.config.type === 'sequence') {
			for (const entry of program.config.entries) {
				countUse(entry.programId);
			}
		}
	}
	return counts;
}
