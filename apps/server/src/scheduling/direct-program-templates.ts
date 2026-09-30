import { createHash } from 'node:crypto';
import {
	DEFAULT_TEMPLATE_BOUNDARY_BEHAVIOR,
	DEFAULT_TEMPLATE_START_ELIGIBILITY,
	SECONDS_PER_SCHEDULING_DAY,
	type ChannelScheduleConfig,
	type ScheduleTemplate,
	type SchedulingProgram,
} from '@moirai/shared';
import { SchedulingValidationError } from './validation.js';

/** Derive a stable UUID without reserving an identity in the repository. */
function virtualId(parts: string[]): string {
	const bytes = createHash('sha256').update(JSON.stringify(['direct-program-template', ...parts])).digest();
	bytes[6] = (bytes[6]! & 0x0f) | 0x50;
	bytes[8] = (bytes[8]! & 0x3f) | 0x80;
	const hex = bytes.toString('hex');
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** Resolve direct program assignments into transient daily templates for the existing engine. */
export function directProgramTemplates(
	channelId: string,
	schedule: ChannelScheduleConfig,
	programs: SchedulingProgram[],
): ScheduleTemplate[] {
	const byId = new Map(programs.map((program) => [program.id, program]));
	const assignments = [
		{ owner: 'base', programId: schedule.defaultProgramId },
		...schedule.layers.map((layer) => ({ owner: layer.id, programId: layer.programId })),
	];
	return assignments.flatMap(({ owner, programId }) => {
		if (!programId) {
			return [];
		}
		const program = byId.get(programId);
		if (!program) {
			throw new SchedulingValidationError(`Direct schedule program ${programId} does not exist`);
		}
		const id = virtualId([channelId, owner, programId, 'template']);
		const slotId = virtualId([channelId, owner, programId, 'slot']);
		return [{
			id,
			name: program.name,
			period: 'day' as const,
			defaultFiller: null,
			slots: [{ id: slotId, startSeconds: 0, programId,
				stateScope: 'persistent' as const,
				startEligibility: DEFAULT_TEMPLATE_START_ELIGIBILITY,
				filler: { mode: 'inherit' as const } }],
			boundaries: [{ id: virtualId([channelId, owner, programId, 'boundary']),
				leftSlotId: slotId, rightSlotId: slotId,
				targetSeconds: SECONDS_PER_SCHEDULING_DAY,
				...DEFAULT_TEMPLATE_BOUNDARY_BEHAVIOR }],
			createdAt: program.createdAt,
			updatedAt: program.updatedAt,
		}];
	});
}

/** Add virtual resources and translate program assignments for the template-based engine. */
export function resolveProgramSchedule(
	channelId: string,
	schedule: ChannelScheduleConfig,
	templates: ScheduleTemplate[],
	programs: SchedulingProgram[],
): { schedule: ChannelScheduleConfig; template: ScheduleTemplate | null; templates: ScheduleTemplate[] } {
	const virtual = directProgramTemplates(channelId, schedule, programs);
	const all = [...templates, ...virtual];
	const baseId = schedule.defaultProgramId
		? virtualId([channelId, 'base', schedule.defaultProgramId, 'template'])
		: schedule.defaultTemplateId;
	const layers = schedule.layers.map((layer) => ({
		...layer,
		templateId: layer.programId
			? virtualId([channelId, layer.id, layer.programId, 'template'])
			: layer.templateId,
	}));
	const resolved = { ...schedule, defaultTemplateId: baseId, defaultProgramId: null,
		layers: layers.map((layer) => ({ ...layer, programId: null })) };
	return { schedule: resolved, template: all.find((candidate) => candidate.id === baseId) ?? null, templates: all };
}
