import { legacyTailPresetId, type ChannelScheduleConfig, type ScheduleTemplateCreate, type FillerKind } from '@moirai/shared';

/** Template fields that own independently inherited filler settings. */
type TemplateAssignments = Pick<ScheduleTemplateCreate, 'defaultMidRoll' | 'defaultPreRoll' | 'defaultPostRoll' | 'defaultFiller' | 'slots'> & { id?: string };
/** Channel fields required to scope templates and collect channel defaults. */
type ScheduleAssignments = Pick<ChannelScheduleConfig, 'defaultMidRoll' | 'defaultPreRoll' | 'defaultPostRoll' | 'defaultTailFiller' | 'defaultTemplateId' | 'layers'>;

/** Collect referenced presets and expected immutable kinds without resolving each airing. */
export function referencedFillerAssignments(templates: TemplateAssignments[], schedules: ScheduleAssignments[] = []): Map<string, Set<FillerKind>> {
	const selected = schedules.length ? new Set(schedules.flatMap(schedule => [schedule.defaultTemplateId, ...schedule.layers.map(layer => layer.templateId)])) : null;
	const references = new Map<string, Set<FillerKind>>();
	const add = (kind: FillerKind, config: { presetId?: string | undefined; policy?: Parameters<typeof legacyTailPresetId>[0] } | null | undefined) => {
		if (config) {
			const id = config.presetId ?? legacyTailPresetId(config.policy ?? 'best-fit-or-truncate');
			const kinds = references.get(id) ?? new Set<FillerKind>();
			kinds.add(kind);
			references.set(id, kinds);
		}
	};
	for (const template of templates) {
		if (selected && template.id && !selected.has(template.id)) {
			continue;
		}
		add('pre-roll', template.defaultPreRoll);
		add('mid-roll', template.defaultMidRoll);
		add('post-roll', template.defaultPostRoll);
		add('tail', template.defaultFiller);
		for (const slot of template.slots) {
			for (const [kind, rule] of [['pre-roll', slot.preRoll], ['mid-roll', slot.midRoll], ['post-roll', slot.postRoll], ['tail', slot.filler]] as const) {
				if (rule?.mode === 'configured') {
					add(kind, rule.config);
				}
			}
		}
	}
	for (const schedule of schedules) {
		add('pre-roll', schedule.defaultPreRoll);
		add('mid-roll', schedule.defaultMidRoll);
		add('post-roll', schedule.defaultPostRoll);
		add('tail', schedule.defaultTailFiller);
	}
	return references;
}
/** Compatibility entry point returning all referenced filler behavior IDs in stable order. */
export function referencedMidRollPresetIds(templates: TemplateAssignments[], schedules: ScheduleAssignments[] = []): string[] {
	return [...referencedFillerAssignments(templates, schedules).keys()].sort();
}
