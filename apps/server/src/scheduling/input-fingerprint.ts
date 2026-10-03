import { createHash } from 'node:crypto';
import type { ChannelSchedule, ScheduleTemplate, SchedulingCatalog, SchedulingProgram, SchedulableMedia } from '@moirai/shared';
import { referencedMidRollPresetIds } from './mid-roll-presets.js';
import { semanticSchedulingFingerprint } from '../semantic/fingerprint.js';
import { templatePlaybackInput } from './template-playback.js';
import { directProgramTemplates } from './direct-program-templates.js';

/** Immutable catalog projection shared by channels with identical source scopes. */
interface FingerprintCatalogScope {
	media: SchedulableMedia[];
	groupParents: Record<string, string | null>;
	groupTitles: Record<string, string | null>;
	libraryNames: Record<string, string | null>;
	libraryEnabled: Record<string, boolean>;
}

/** Cache immutable canonical inputs for one pass without changing persisted fingerprint bytes. */
export class InputFingerprintContext {
	private readonly normalized = new WeakMap<SchedulableMedia, SchedulableMedia>();
	private readonly serialized = new WeakMap<object, string>();
	private readonly scopes = new WeakMap<SchedulingCatalog, Map<string, FingerprintCatalogScope>>();
	private readonly playbackInputs = new WeakMap<ScheduleTemplate, ScheduleTemplate>();

	/** Reuse source projections only within this immutable catalog and materialization pass. */
	scope(catalog: SchedulingCatalog, libraryIds: Set<string>, itemIds: Set<string>, groupIds: Set<string>): FingerprintCatalogScope {
		let scopes = this.scopes.get(catalog);
		if (!scopes) {
			scopes = new Map();
			this.scopes.set(catalog, scopes);
		}
		const key = JSON.stringify([[...libraryIds].sort(), [...itemIds].sort(), [...groupIds].sort()]);
		let value = scopes.get(key);
		if (!value) {
			value = catalogScope(catalog, libraryIds, itemIds, groupIds, this);
			scopes.set(key, value);
		}
		return value;
	}

	/** Strip presentation settings once per saved template, preserving the old hash shape. */
	playback(template: ScheduleTemplate): ScheduleTemplate {
		let value = this.playbackInputs.get(template);
		if (!value) {
			value = templatePlaybackInput(template);
			this.playbackInputs.set(template, value);
		}
		return value;
	}

	/** Share normalized catalog rows across channels while ignoring transient availability. */
	media(value: SchedulableMedia): SchedulableMedia {
		let result = this.normalized.get(value);
		if (!result) {
			result = { ...value, availability: 'ignored' as SchedulableMedia['availability'] };
			this.normalized.set(value, result);
		}
		return result;
	}

	/** Hash the same canonical serialization used by earlier committed schedules. */
	fingerprint(value: unknown): string {
		return createHash('sha256').update(this.serialize(value)).digest('hex');
	}

	/** Serialize immutable objects once, retaining stable key ordering and array order. */
	private serialize(value: unknown): string {
		if (value && typeof value === 'object') {
			const cached = this.serialized.get(value);
			if (cached !== undefined) {
				return cached;
			}
			const result = Array.isArray(value)
				? `[${value.map(item => this.serialize(item)).join(',')}]`
				: `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
					.map(([key, item]) => `${JSON.stringify(key)}:${this.serialize(item)}`).join(',')}}`;
			this.serialized.set(value, result);
			return result;
		}
		return JSON.stringify(value);
	}
}

/** Return whether a media group is contained by any selected group. */
function belongsToGroup(
	groupId: string | null,
	candidates: Set<string>,
	parents: Record<string, string | null>,
): boolean {
	let current = groupId;
	const visited = new Set<string>();
	while (current && !visited.has(current)) {
		if (candidates.has(current)) {
			return true;
		}

		visited.add(current);
		current = parents[current] ?? null;
	}
	return false;
}

/** Collect every program reachable from the selected schedule resources. */
export function referencedPrograms(
	templateIds: Set<string>,
	templates: ScheduleTemplate[],
	programs: SchedulingProgram[],
	seedProgramIds: string[] = [],
): SchedulingProgram[] {
	const ids = new Set<string>(seedProgramIds);
	for (const template of templates) {
		if (!templateIds.has(template.id)) {
			continue;
		}

		for (const slot of template.slots) {
			if (slot.programId) {
				ids.add(slot.programId);
			}
			for (const rule of [slot.preRoll, slot.postRoll]) {
				if (rule?.mode === 'configured') {
					ids.add(rule.config.programId);
				}
			}
			if (slot.midRoll?.mode === 'configured') {
				ids.add(slot.midRoll.config.programId);
			}
			if (slot.filler.mode === 'configured') {
				ids.add(slot.filler.config.programId);
			}
		}
		for (const config of [template.defaultPreRoll, template.defaultPostRoll]) {
			if (config) {
				ids.add(config.programId);
			}
		}
		if (template.defaultMidRoll) {
			ids.add(template.defaultMidRoll.programId);
		}
		if (template.defaultFiller) {
			ids.add(template.defaultFiller.programId);
		}
	}
	let changed = true;
	while (changed) {
		changed = false;
		for (const program of programs) {
			if (ids.has(program.id) && program.config.type === 'similarity' && !ids.has(program.config.sourceProgramId)) {
				ids.add(program.config.sourceProgramId);
				changed = true;
			}
			if (!ids.has(program.id) || program.config.type !== 'sequence') {
				continue;
			}

			for (const entry of program.config.entries) {
				if (!ids.has(entry.programId)) {
					ids.add(entry.programId);
					changed = true;
				}
			}
		}
	}
	return programs.filter((program) => ids.has(program.id));
}

/** Hash programming inputs that determine whether committed future output is stale. */
export function inputFingerprint(
	schedule: ChannelSchedule,
	templates: ScheduleTemplate[],
	programs: SchedulingProgram[],
	catalog: SchedulingCatalog,
	context: InputFingerprintContext = new InputFingerprintContext(),
): string {
	// Restrict templates and recursively referenced programs to this channel schedule.
	const virtualTemplates = directProgramTemplates(schedule.channelId, schedule, programs);
	const templateIds = new Set([
		schedule.defaultTemplateId,
		...schedule.layers.map((layer) => layer.templateId),
		...virtualTemplates.map((template) => template.id),
	].filter((id): id is string => id !== null));
	const selectedTemplates = [...templates, ...virtualTemplates]
		.filter((template) => templateIds.has(template.id))
		.sort((left, right) => left.id.localeCompare(right.id));
	const selectedPrograms = referencedPrograms(
		templateIds,
		[...templates, ...virtualTemplates],
		programs,
		[
			...(schedule.defaultFiller ? [schedule.defaultFiller.programId] : []),
			...[schedule.defaultPreRoll, schedule.defaultPostRoll, schedule.defaultTailFiller].flatMap(config => config ? [config.programId] : []),
			...(schedule.defaultMidRoll ? [schedule.defaultMidRoll.programId] : []),
			...(schedule.defaultProgramId ? [schedule.defaultProgramId] : []),
			...schedule.layers.flatMap((layer) => layer.programId ? [layer.programId] : []),
		],
	).sort((left, right) => left.id.localeCompare(right.id));

	// Collect only catalog scopes that can affect those programs.
	const libraryIds = new Set<string>();
	const itemIds = new Set<string>();
	const groupIds = new Set<string>();
	for (const program of selectedPrograms) {
		if (program.config.type === 'theme') {
			libraryIds.add(program.config.libraryId);
			continue;
		}
		if (program.config.type !== 'content') {
			continue;
		}

		const source = program.config.source;
		if (source.type === 'item') {
			itemIds.add(source.itemId);
		}
		else if (source.type === 'group') {
			groupIds.add(source.groupId);
		}
		else {
			libraryIds.add(source.libraryId);
			if (source.type === 'group-collection') {
				for (const groupId of source.groupIds) {
					groupIds.add(groupId);
				}
			}
		}
	}

	const scope = context.scope(catalog, libraryIds, itemIds, groupIds);

	// Hash stable authored inputs and catalog eligibility data together.
	return context.fingerprint({
		schedule,
		templates: selectedTemplates.map(template => context.playback(template)),
		programs: selectedPrograms,
		catalog: {
			midRollPresets: Object.fromEntries(referencedMidRollPresetIds(selectedTemplates, [schedule])
				.map(id => [id, catalog.fillerPresets?.[id] ?? catalog.midRollPresets?.[id]])),
			semantic: semanticSchedulingFingerprint(schedule.channelId, selectedPrograms, catalog),
			...scope,
		},
	});
}



/** Select stable media, ancestor labels, and library attributes without changing fingerprint bytes. */
function catalogScope(catalog: SchedulingCatalog, libraryIds: Set<string>, itemIds: Set<string>, groupIds: Set<string>, context: InputFingerprintContext): FingerprintCatalogScope {
	// Include matching media while ignoring transient availability in the durable fingerprint.
	const selectedMedia = catalog.media
		.filter(
			(media) =>
				libraryIds.has(media.libraryId)
				|| itemIds.has(media.id)
				|| belongsToGroup(media.groupId, groupIds, catalog.groupParents),
		)
		.map((media) => context.media(media))
		.sort((left, right) => left.id.localeCompare(right.id));
	const selectedLibraryIds = new Set(libraryIds);
	for (const media of selectedMedia) {
		selectedLibraryIds.add(media.libraryId);
	}

	// Include the ancestor hierarchy and library attributes used during materialization.
	const selectedGroupIds = new Set(groupIds);
	for (const media of selectedMedia) {
		let groupId = media.groupId;
		while (groupId && !selectedGroupIds.has(groupId)) {
			selectedGroupIds.add(groupId);
			groupId = catalog.groupParents[groupId] ?? null;
		}
	}

	return {
		media: selectedMedia,
		groupParents: Object.fromEntries(
			[...selectedGroupIds].map((id) => [id, catalog.groupParents[id] ?? null]),
		),
		groupTitles: Object.fromEntries(
			[...selectedGroupIds].map((id) => [id, catalog.groupTitles[id] ?? null]),
		),
		libraryNames: Object.fromEntries(
			[...selectedLibraryIds].map((id) => [id, catalog.libraryNames[id] ?? null]),
		),
		libraryEnabled: Object.fromEntries(
			[...selectedLibraryIds].map((id) => [id, catalog.libraryEnabled?.[id] ?? true]),
		),
	};
}
