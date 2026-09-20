import type {
	ChannelScheduleConfig,
	FillerConfig,
	ProgramConfig,
	ScheduleTemplateCreate,
	SchedulingProgram,
} from '@moirai/shared';
import { SECONDS_PER_SCHEDULING_DAY } from '@moirai/shared';

/** Report an invalid relationship between authored scheduling resources. */
export class SchedulingValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'SchedulingValidationError';
	}
}

/** Collect the stable identifiers for referenced program. */
function referencedProgramIds(config: ProgramConfig): string[] {
	return config.type === 'sequence' ? config.entries.map((entry) => entry.programId)
		: config.type === 'similarity' ? [config.sourceProgramId] : [];
}

/** Ensure a filler reference exists and cannot recursively select filler. */
function assertFillerProgram(filler: FillerConfig | null, programIds: Set<string>): void {
	if (filler && !programIds.has(filler.programId)) {
		throw new SchedulingValidationError(`Filler program ${filler.programId} does not exist`);
	}
}

/** Validate program references, source scopes, and composite cycles. */
export function validatePrograms(programs: SchedulingProgram[]): void {
	const byId = new Map(programs.map((program) => [program.id, program]));
	for (const program of programs) {
		if (program.config.type === 'similarity') {
			const source = byId.get(program.config.sourceProgramId);
			if (source?.config.type !== 'content' || source.config.source.type !== 'collection') {
				throw new SchedulingValidationError('Similar Items requires a Specific media items Program');
			}
		}

		for (const referencedId of referencedProgramIds(program.config)) {
			if (!byId.has(referencedId)) {
				throw new SchedulingValidationError(
					`Sequence ${program.name} references missing program ${referencedId}`,
				);
			}
		}
	}

	const visiting = new Set<string>();
	const visited = new Set<string>();
	const visit = (id: string): void => {
		if (visiting.has(id)) {
			throw new SchedulingValidationError('Composite program references must not form a cycle');
		}

		if (visited.has(id)) {
			return;
		}

		visiting.add(id);
		const program = byId.get(id);
		if (program) {
			for (const referencedId of referencedProgramIds(program.config)) {
				visit(referencedId);
			}
		}
		visiting.delete(id);
		visited.add(id);
	};
	for (const id of byId.keys()) {
		visit(id);
	}
}

/** Enforce a contiguous daily template with one explicit boundary per adjacent slot pair. */
export function validateTemplate(
	template: ScheduleTemplateCreate,
	programs: SchedulingProgram[],
): void {
	const programIds = new Set(programs.map((program) => program.id));
	const slots = [...template.slots].sort((a, b) => a.startSeconds - b.startSeconds);
	if (slots[0]?.startSeconds !== 0) {
		throw new SchedulingValidationError('A daily template must begin at 00:00');
	}

	if (new Set(slots.map((slot) => slot.id)).size !== slots.length) {
		throw new SchedulingValidationError('Slot IDs must be unique within a template');
	}

	if (new Set(slots.map((slot) => slot.startSeconds)).size !== slots.length) {
		throw new SchedulingValidationError('Slot start times must be unique within a template');
	}

	for (const slot of slots) {
		if (slot.programId !== null && !programIds.has(slot.programId)) {
			throw new SchedulingValidationError(`Slot program ${slot.programId} does not exist`);
		}

		if (slot.programId !== null && slot.filler.mode === 'configured') {
			assertFillerProgram(slot.filler.config, programIds);
		}
		if (slot.programId === null && slot.filler.mode !== 'disabled') {
			throw new SchedulingValidationError('A no-program slot must disable slot filler');
		}
	}
	assertFillerProgram(template.defaultFiller, programIds);

	if (template.boundaries.length !== slots.length) {
		throw new SchedulingValidationError('A template must have one boundary after every slot');
	}

	if (new Set(template.boundaries.map((boundary) => boundary.id)).size !== slots.length) {
		throw new SchedulingValidationError('Boundary IDs must be unique within a template');
	}

	const byLeft = new Map(template.boundaries.map((boundary) => [boundary.leftSlotId, boundary]));
	if (byLeft.size !== slots.length) {
		throw new SchedulingValidationError('Each slot must own exactly one outgoing boundary');
	}

	slots.forEach((slot, index) => {
		const next = slots[(index + 1) % slots.length]!;
		const boundary = byLeft.get(slot.id);
		const expectedTarget
			= index === slots.length - 1 ? SECONDS_PER_SCHEDULING_DAY : next.startSeconds;
		if (
			!boundary
			|| boundary.rightSlotId !== next.id
			|| boundary.targetSeconds !== expectedTarget
		) {
			throw new SchedulingValidationError(
				`Boundary after slot ${slot.id} must target the next nominal slot`,
			);
		}
	});
}

/** Validate template layers, predicates, and boundary configuration for a channel. */
export function validateChannelSchedule(
	config: ChannelScheduleConfig,
	templateIds: Set<string>,
	programIds: Set<string>,
): void {
	if (!templateIds.has(config.defaultTemplateId)) {
		throw new SchedulingValidationError('The default schedule template does not exist');
	}

	const layerIds = new Set<string>();
	for (const layer of config.layers) {
		if (layerIds.has(layer.id)) {
			throw new SchedulingValidationError(`Schedule layer ${layer.id} is duplicated`);
		}

		layerIds.add(layer.id);
		if (!templateIds.has(layer.templateId)) {
			throw new SchedulingValidationError(
				`Schedule layer template ${layer.templateId} does not exist`,
			);
		}
	}
	assertFillerProgram(config.defaultFiller, programIds);
}
