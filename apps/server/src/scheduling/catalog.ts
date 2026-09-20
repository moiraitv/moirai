import type {
	ChannelSchedule,
	ScheduleTemplate,
	SchedulingCatalog,
	SchedulingProgram,
	SchedulableMedia,
} from '@moirai/shared';

/** Library, group, and item identifiers referenced by a set of programs. */
export interface SchedulingCatalogScope {
	itemIds: string[];
	groupIds: string[];
	sourceLibraryIds: string[];
	libraryIds: string[];
}

/** Collect direct program roots used by selected template stacks and channel filler. */
export function schedulingRootProgramIds(
	templates: ScheduleTemplate[],
	schedules?: ChannelSchedule[],
): Set<string> {
	const templateIds = schedules
		? new Set(
			schedules.flatMap((schedule) => [
				schedule.defaultTemplateId,
				...schedule.layers.map((layer) => layer.templateId),
			]),
		)
		: new Set(templates.map((template) => template.id));
	const ids = new Set<string>();
	for (const template of templates) {
		if (!templateIds.has(template.id)) {
			continue;
		}

		for (const slot of template.slots) {
			if (slot.programId) {
				ids.add(slot.programId);
			}
			if (slot.filler.mode === 'configured') {
				ids.add(slot.filler.config.programId);
			}
		}
		if (template.defaultFiller) {
			ids.add(template.defaultFiller.programId);
		}
	}
	for (const schedule of schedules ?? []) {
		if (schedule.defaultFiller) {
			ids.add(schedule.defaultFiller.programId);
		}
	}
	return ids;
}

/** Resolve only Programs reachable through sequence entries and similarity sources. */
export function reachableSchedulingPrograms(programs: SchedulingProgram[], rootProgramIds?: Iterable<string>): SchedulingProgram[] {
	const byId = new Map(programs.map((program) => [program.id, program]));
	const pending = rootProgramIds ? [...rootProgramIds] : programs.map((program) => program.id);
	const visited = new Set<string>();
	const result: SchedulingProgram[] = [];
	while (pending.length) {
		const id = pending.pop()!;
		if (visited.has(id)) {
			continue;
		}
		visited.add(id);
		const program = byId.get(id);
		if (!program) {
			continue;
		}
		result.push(program);
		if (program.config.type === 'sequence') {
			pending.push(...program.config.entries.map((entry) => entry.programId));
		}
		else if (program.config.type === 'similarity') {
			pending.push(program.config.sourceProgramId);
		}
	}
	return result;
}

/** Follow composite programs and collect only catalog references reachable from the roots. */
export function schedulingCatalogScope(
	programs: SchedulingProgram[],
	rootProgramIds?: Iterable<string>,
): SchedulingCatalogScope {
	const byId = new Map(programs.map((program) => [program.id, program]));
	const itemIds = new Set<string>();
	const groupIds = new Set<string>();
	const libraryIds = new Set<string>();
	const sourceLibraryIds = new Set<string>();
	for (const program of reachableSchedulingPrograms(programs, rootProgramIds)) {
		if (program.config.type === 'sequence') {
			continue;
		}

		if (program.config.type === 'similarity') {
			const anchor = byId.get(program.config.sourceProgramId);
			if (anchor?.config.type === 'content' && anchor.config.source.type === 'collection') {
				libraryIds.add(anchor.config.source.libraryId);
				sourceLibraryIds.add(anchor.config.source.libraryId);
			}
			continue;
		}

		if (program.config.type === 'theme') {
			libraryIds.add(program.config.libraryId);
			sourceLibraryIds.add(program.config.libraryId);
			continue;
		}

		const source = program.config.source;
		if (source.type === 'item') {
			itemIds.add(source.itemId);
		}
		else if (source.type === 'group') {
			groupIds.add(source.groupId);
		}
		else if (source.type === 'collection') {
			sourceLibraryIds.add(source.libraryId);
			source.itemIds.forEach((itemId) => itemIds.add(itemId));
		}
		else if (source.type === 'group-collection') {
			sourceLibraryIds.add(source.libraryId);
			source.groupIds.forEach((groupId) => groupIds.add(groupId));
		}
		else {
			libraryIds.add(source.libraryId);
			sourceLibraryIds.add(source.libraryId);
		}
	}
	return {
		itemIds: [...itemIds].sort(),
		groupIds: [...groupIds].sort(),
		sourceLibraryIds: [...sourceLibraryIds].sort(),
		libraryIds: [...libraryIds].sort(),
	};
}

/** Add lookup indexes used repeatedly by selection and health calculations. */
export function indexSchedulingCatalog(catalog: SchedulingCatalog): SchedulingCatalog {
	const mediaById = new Map<string, SchedulableMedia>();
	const mediaByLibrary = new Map<string, SchedulableMedia[]>();
	const mediaByGroup = new Map<string, SchedulableMedia[]>();
	for (const media of catalog.media) {
		mediaById.set(media.id, media);
		mediaByLibrary.set(media.libraryId, [...(mediaByLibrary.get(media.libraryId) ?? []), media]);
		if (media.groupId) {
			mediaByGroup.set(media.groupId, [...(mediaByGroup.get(media.groupId) ?? []), media]);
		}
	}
	return { ...catalog, mediaById, mediaByLibrary, mediaByGroup };
}
