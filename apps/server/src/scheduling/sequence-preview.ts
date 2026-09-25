import { Temporal } from '@js-temporal/polyfill';
import { SECONDS_PER_SCHEDULING_DAY, scheduleTemplateCreateSchema, type SequencePreview, type SchedulingProgram } from '@moirai/shared';
import type { SchedulingRepository } from '../repository/scheduling.js';
import { currentTimestamp } from '../time.js';
import type { GenerateTimelineInput } from './engine.js';
import { validatePrograms } from './validation.js';

/** Prepare a fresh, read-only sample using only the draft's reachable saved child Programs. */
export async function prepareSequencePreview(
	repository: SchedulingRepository,
	input: SequencePreview,
	timeZone: string,
): Promise<GenerateTimelineInput> {
	const timestamp = currentTimestamp();
	const root: SchedulingProgram = { id: input.id, name: 'Sequence preview', config: input.config,
		createdAt: timestamp, updatedAt: timestamp };
	const saved = new Map((await repository.listPrograms()).map(program => [program.id, program]));
	saved.set(root.id, root);
	const reachable = new Map<string, SchedulingProgram>();
	const pending = [root.id];
	while (pending.length) {
		const id = pending.pop()!;
		const program = saved.get(id);
		if (!program || reachable.has(id)) {
			continue;
		}
		reachable.set(id, program);
		if (program.config.type === 'sequence') {
			pending.push(...program.config.entries.map(entry => entry.programId));
		}
		else if (program.config.type === 'similarity') {
			pending.push(program.config.sourceProgramId);
		}
	}
	const programs = [...reachable.values()];
	validatePrograms(programs);

	// Synthetic identities remain stable but are never written to the database.
	const template = { ...scheduleTemplateCreateSchema.parse({
		name: 'Sequence sample day',
		slots: [{ id: root.id, startSeconds: 0, programId: root.id, stateScope: 'persistent',
			startEligibility: { type: 'allow-overrun' }, filler: { mode: 'disabled' } }],
		boundaries: [{ id: root.id, leftSlotId: root.id, rightSlotId: root.id, targetSeconds: SECONDS_PER_SCHEDULING_DAY,
			policy: 'finish-left', maxDriftSeconds: null }],
	}), id: root.id, createdAt: timestamp, updatedAt: timestamp };
	const catalog = await repository.getSchedulingCatalog(programs, [root.id]);
	return {
		channelId: root.id, timeZone,
		startDate: input.startDate ?? Temporal.Now.plainDateISO(timeZone).toString(), days: 1,
		schedule: { channelId: root.id, defaultTemplateId: root.id, layers: [], defaultFiller: null,
			createdAt: timestamp, updatedAt: timestamp },
		template, templates: [template], programs, catalog, state: [],
	};
}
