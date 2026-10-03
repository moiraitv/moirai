import type { ChannelSchedule, FillerConfig, FillerAssignment, FillerSettings, ResolvedMidRollConfig, ScheduleSlot, ScheduleTemplate, SchedulingCatalog } from '@moirai/shared';

/** One resolved introduction or closing with an independently scoped source cursor. */
export type AiringFillerStage = FillerSettings & { programId: string; consumerKey: string };

/** Effective pre/mid/post behavior for one programmed slot. */
export interface ResolvedAiringFiller {
	midRoll: ResolvedMidRollConfig | null;
	midRollConsumerKey: string;
	pre: AiringFillerStage | undefined;
	post: AiringFillerStage | undefined;
}

/** Resolve slot overrides before template and channel defaults, rejecting missing presets. */
export function resolveAiringFiller(
	slot: ScheduleSlot,
	template: ScheduleTemplate,
	schedule: ChannelSchedule,
	catalog: SchedulingCatalog,
	key: (kind: 'pre-roll' | 'mid-roll' | 'post-roll', programId: string) => string,
): ResolvedAiringFiller {
	const assignment = slot.midRoll?.mode === 'disabled' ? null
		: slot.midRoll?.mode === 'configured' ? slot.midRoll.config : template.defaultMidRoll ?? schedule.defaultMidRoll;
	const settings = assignment ? catalog.midRollPresets?.[assignment.presetId] : null;
	if (assignment && !settings) {
		throw new Error('Selected mid-roll preset is unavailable');
	}
	const midRoll = assignment && settings ? { ...settings, programId: assignment.programId } : null;
	const resolve = (config: FillerAssignment | null | undefined, kind: 'pre-roll' | 'post-roll'): AiringFillerStage | undefined => {
		if (!config) {
			return undefined;
		}
		const preset = catalog.fillerPresets?.[config.presetId];
		if (!preset) {
			throw new Error('Selected filler preset is unavailable');
		}
		return { ...preset, programId: config.programId, consumerKey: key(kind, config.programId) };
	};
	const pre = slot.preRoll?.mode === 'disabled' ? null : slot.preRoll?.mode === 'configured'
		? slot.preRoll.config : template.defaultPreRoll ?? schedule.defaultPreRoll;
	const post = slot.postRoll?.mode === 'disabled' ? null : slot.postRoll?.mode === 'configured'
		? slot.postRoll.config : template.defaultPostRoll ?? schedule.defaultPostRoll;
	return { midRoll, midRollConsumerKey: midRoll ? key('mid-roll', midRoll.programId) : '',
		pre: resolve(pre, 'pre-roll'), post: resolve(post, 'post-roll') };
}

/** Resolve tail independently of fallback, retaining migrated channel filler in empty slots. */
export function resolveTailFiller(
	slot: ScheduleSlot,
	template: ScheduleTemplate,
	schedule: ChannelSchedule,
): FillerConfig | null {
	if (slot.programId === null) {
		return schedule.defaultTailFiller?.legacyEmptySlots ? schedule.defaultTailFiller : null;
	}

	if (slot.filler.mode === 'disabled') {
		return null;
	}

	if (slot.filler.mode === 'configured') {
		return slot.filler.config;
	}

	return template.defaultFiller ?? schedule.defaultTailFiller ?? null;
}

