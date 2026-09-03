import { Temporal } from '@js-temporal/polyfill';
import type { ScheduleTemplate, TimelinePreview } from '@moirai/shared';

/** Counts and clipped dead-air duration for the first local calendar day of a cached preview. */
export interface ScheduleDaySummary {
	gapCount: number;
	deadAirSeconds: number;
	programmedCount: number;
}

/** Summarize only segments overlapping the first local day, including DST-short and DST-long days. */
export function firstDayScheduleSummary(preview: TimelinePreview): ScheduleDaySummary {
	const date = Temporal.PlainDate.from(preview.startDate);
	const start = date.toZonedDateTime(preview.timeZone).epochMilliseconds;
	const finish = date.add({ days: 1 }).toZonedDateTime(preview.timeZone).epochMilliseconds;
	const summary: ScheduleDaySummary = { gapCount: 0, deadAirSeconds: 0, programmedCount: 0 };
	for (const segment of preview.segments) {
		const clippedStart = Math.max(start, Date.parse(segment.start));
		const clippedFinish = Math.min(finish, Date.parse(segment.finish));
		if (clippedStart >= clippedFinish) {
			continue;
		}

		if (segment.role === 'dead-air') {
			summary.gapCount += 1;
			summary.deadAirSeconds += (clippedFinish - clippedStart) / 1000;
		}
		else {
			summary.programmedCount += 1;
		}
	}
	return summary;
}

/** Label and horizontal position for a preview time ruler. */
export interface ScheduleRulerMark {
	seconds: number;
	label: string;
}

/** Program identity and color shown in a schedule preview legend. */
export interface SchedulePreviewLegendEntry {
	templateId: string;
	name: string;
	programIds: string[];
	isBase: boolean;
}

/** Build the fixed three-hour ruler used by the one-day channel schedule preview. */
export function scheduleRulerMarks(): ScheduleRulerMark[] {
	return Array.from({ length: 9 }, (_, index) => {
		const hours = index * 3;
		return {
			seconds: hours * 3_600,
			label: `${String(hours).padStart(2, '0')}:00`,
		};
	});
}

/** Summarize only templates present in resolved output while retaining their stable program colors. */
export function schedulePreviewLegend(
	preview: TimelinePreview | null,
	templates: ScheduleTemplate[],
	baseTemplateId: string | null,
): SchedulePreviewLegendEntry[] {
	if (!preview) {
		return [];
	}

	const names = new Map(templates.map((template) => [template.id, template.name]));
	const entries = new Map<string, SchedulePreviewLegendEntry>();
	for (const segment of preview.segments) {
		const existing = entries.get(segment.templateId);
		const entry = existing ?? {
			templateId: segment.templateId,
			name: names.get(segment.templateId) ?? 'Missing template',
			programIds: [],
			isBase: segment.templateId === baseTemplateId || segment.scheduleLayerId === null,
		};
		if (segment.programId && !entry.programIds.includes(segment.programId)) {
			entry.programIds.push(segment.programId);
		}
		entry.isBase ||= segment.templateId === baseTemplateId || segment.scheduleLayerId === null;
		entries.set(segment.templateId, entry);
	}
	return [...entries.values()];
}
