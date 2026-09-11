import { createHash } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import type { ChannelSchedule, GuideOccurrence, ScheduleTemplate } from '@moirai/shared';
import { instantFor, resolveScheduleDay, type ResolvedScheduleSlot } from '../scheduling/schedule-day.js';
import type { MaterializedSegmentRecord } from '../repository/contracts.js';

/** Capture nominal identity independently of the content chosen for this occurrence. */
export function guideOccurrence(channelId: string, resolved: ResolvedScheduleSlot, date: Temporal.PlainDate, timeZone: string): GuideOccurrence {
	const start = instantFor(date, resolved.startSeconds, timeZone).toString();
	const finish = instantFor(date, resolved.endSeconds, timeZone).toString();
	const { template, slot, layerId } = resolved;
	return {
		id: createHash('sha256').update(JSON.stringify([channelId, template.id, slot.id, layerId, start, finish])).digest('hex'),
		templateId: template.id, slotId: slot.id, scheduleLayerId: layerId, programId: slot.programId,
		start, finish, actualStart: null, actualFinish: null,
	};
}

/** Retain committed history and combine resumed occurrences without changing segment ownership. */
export function mergeGuideOccurrences(previous: GuideOccurrence[], generated: GuideOccurrence[], start: string, finish: string, replaceFrom: string): GuideOccurrence[] {
	const incoming = new Map(generated.filter((entry) => Date.parse(entry.finish) > Date.parse(replaceFrom)
		|| (entry.actualFinish !== null && Date.parse(entry.actualFinish) > Date.parse(replaceFrom))).map((entry) => [entry.id, { ...entry }]));
	const retained: GuideOccurrence[] = [];
	for (const entry of previous) {
		const next = incoming.get(entry.id);
		if (next) {
			// Preserve a nominal start already clipped by an earlier configuration handoff.
			if (Date.parse(entry.start) > Date.parse(next.start)) {
				next.start = entry.start;
			}
			if (entry.actualStart && Date.parse(entry.actualStart) < Date.parse(replaceFrom)) {
				next.actualStart = entry.actualStart;
				next.actualFinish ??= entry.actualFinish && Date.parse(entry.actualFinish) < Date.parse(replaceFrom) ? entry.actualFinish : replaceFrom;
			}
		}
		else if (Date.parse(entry.start) < Date.parse(replaceFrom)) {
			retained.push({
				...entry,
				finish: Date.parse(entry.finish) < Date.parse(replaceFrom) ? entry.finish : replaceFrom,
				actualFinish: entry.actualFinish && Date.parse(entry.actualFinish) > Date.parse(replaceFrom) ? replaceFrom : entry.actualFinish,
			});
		}
	}
	// Replacement blocks must not reclaim nominal time owned by retained history.
	const retainedThrough = retained.reduce((latest, entry) => Math.max(latest, Date.parse(entry.finish)), -Infinity);
	for (const entry of incoming.values()) {
		if (Date.parse(entry.start) < retainedThrough) {
			entry.start = Date.parse(entry.finish) <= retainedThrough ? entry.finish : new Date(retainedThrough).toISOString();
		}
	}
	return [...retained, ...incoming.values()].filter((entry) => (Date.parse(entry.start) < Date.parse(finish) || (entry.actualStart !== null && Date.parse(entry.actualStart) < Date.parse(finish)))
		&& (Date.parse(entry.finish) > Date.parse(start) || (entry.actualFinish !== null && Date.parse(entry.actualFinish) > Date.parse(start))))
		.sort((left, right) => Date.parse(left.start) - Date.parse(right.start));
}

/**
 * Recover legacy occurrence associations without replaying selection. Ambiguous runs remain raw
 * items; pending structural edits must not be used to reconstruct committed nominal boundaries.
 */
export function recoverGuideOccurrences(
	schedule: ChannelSchedule,
	templates: ScheduleTemplate[],
	rows: MaterializedSegmentRecord[],
	startDate: string,
	days: number,
	timeZone: string,
): GuideOccurrence[] {
	const template = templates.find((entry) => entry.id === schedule.defaultTemplateId);
	if (!template) {
		return [];
	}

	const candidates: GuideOccurrence[] = [];
	const date = Temporal.PlainDate.from(startDate);
	for (let offset = -1; offset <= days; offset += 1) {
		const day = date.add({ days: offset });
		for (const resolved of resolveScheduleDay({ schedule, template, templates, timeZone }, day)) {
			candidates.push(guideOccurrence(schedule.channelId, resolved, day, timeZone));
		}
	}

	const byOwner = new Map<string, GuideOccurrence[]>();
	for (const candidate of candidates) {
		const key = JSON.stringify([candidate.templateId, candidate.slotId, candidate.scheduleLayerId]);
		const entries = byOwner.get(key) ?? [];
		entries.push(candidate);
		byOwner.set(key, entries);
	}
	const uncertain = new Set<string>();
	for (const { segment, continuation } of rows) {
		const owner = byOwner.get(JSON.stringify([segment.templateId, segment.slotId, segment.scheduleLayerId])) ?? [];
		const matching = owner.filter((entry) => continuation
			? entry.start === continuation.intervalStart && entry.finish === continuation.intervalEnd
			: Date.parse(entry.start) < Date.parse(segment.finish) && Date.parse(entry.finish) > Date.parse(segment.start));
		if (matching.length !== 1) {
			for (const entry of matching) {
				uncertain.add(entry.id);
			}
			continue;
		}

		const entry = matching[0]!;
		entry.actualStart = entry.actualStart === null || Date.parse(segment.start) < Date.parse(entry.actualStart) ? segment.start : entry.actualStart;
		entry.actualFinish = entry.actualFinish === null || Date.parse(segment.finish) > Date.parse(entry.actualFinish) ? segment.finish : entry.actualFinish;
	}
	return candidates.filter((entry) => !uncertain.has(entry.id));
}
