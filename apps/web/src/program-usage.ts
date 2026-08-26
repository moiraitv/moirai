import type { SchedulingOverview } from '@moirai/shared';

/** Count every authored reference that prevents a scheduling program from being deleted. */
export function countProgramUsages(overview: SchedulingOverview | null): Map<string, number> {
	const counts = new Map<string, number>();
	const countUse = (programId: string) => {
		counts.set(programId, (counts.get(programId) ?? 0) + 1);
	};
	for (const template of overview?.templates ?? []) {
		if (template.defaultFiller) {
			countUse(template.defaultFiller.programId);
		}
		for (const slot of template.slots) {
			if (slot.programId !== null) {
				countUse(slot.programId);
			}
			if (slot.filler.mode === 'configured') {
				countUse(slot.filler.config.programId);
			}
		}
	}
	for (const schedule of overview?.channelSchedules ?? []) {
		if (schedule.defaultFiller) {
			countUse(schedule.defaultFiller.programId);
		}
	}
	for (const program of overview?.programs ?? []) {
		if (program.config.type === 'sequence') {
			for (const entry of program.config.entries) {
				countUse(entry.programId);
			}
		}
	}
	return counts;
}
