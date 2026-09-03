import { Temporal } from '@js-temporal/polyfill';
import { SECONDS_PER_SCHEDULING_DAY, type ScheduleGuide, type ScheduleTemplate, type TimelinePreview } from '@moirai/shared';

/** Exact rolling interval and the smallest local-date guide request that covers it. */
export interface ScheduleSummaryWindow {
	start: number;
	finish: number;
	startDate: string;
	days: number;
	timeZone: string;
}

/** Counts and clipped dead-air duration within an upcoming programming interval. */
export interface ScheduleDaySummary {
	gapCount: number;
	deadAirSeconds: number;
	programmedCount: number;
}

/** Cover 24 elapsed hours, requesting every local date touched even across DST changes. */
export function upcomingScheduleWindow(now: number, timeZone: string): ScheduleSummaryWindow {
	const finish = now + SECONDS_PER_SCHEDULING_DAY * 1_000;
	const firstDate = Temporal.Instant.fromEpochMilliseconds(now).toZonedDateTimeISO(timeZone).toPlainDate();
	const lastDate = Temporal.Instant.fromEpochMilliseconds(finish - 1)
		.toZonedDateTimeISO(timeZone).toPlainDate();
	return {
		start: now, finish, startDate: firstDate.toString(), timeZone,
		days: firstDate.until(lastDate, { largestUnit: 'days' }).days + 1,
	};
}

/** Accept cached guides only when their actual returned range covers the complete interval. */
export function guideCoversScheduleWindow(
	guide: ScheduleGuide | null,
	window: ScheduleSummaryWindow,
): boolean {
	if (!guide || guide.timeZone !== window.timeZone) {
		return false;
	}

	const date = Temporal.PlainDate.from(guide.startDate);
	const start = date.toZonedDateTime(guide.timeZone).epochMilliseconds;
	const finish = date.add({ days: guide.days }).toZonedDateTime(guide.timeZone).epochMilliseconds;
	return start <= window.start && finish >= window.finish;
}

/** Count clipped programming and coalesce contiguous dead air within the upcoming interval. */
export function upcomingScheduleSummary(
	preview: TimelinePreview,
	window: ScheduleSummaryWindow,
): ScheduleDaySummary {
	const summary: ScheduleDaySummary = { gapCount: 0, deadAirSeconds: 0, programmedCount: 0 };
	const gaps: Array<{ start: number; finish: number }> = [];
	for (const segment of preview.segments) {
		const clippedStart = Math.max(window.start, Date.parse(segment.start));
		const clippedFinish = Math.min(window.finish, Date.parse(segment.finish));
		if (clippedStart >= clippedFinish) {
			continue;
		}

		if (segment.role === 'dead-air') {
			gaps.push({ start: clippedStart, finish: clippedFinish });
		}
		else {
			summary.programmedCount += 1;
		}
	}

	// Treat adjacent daily materialization rows as one uninterrupted playback gap.
	gaps.sort((left, right) => left.start - right.start || left.finish - right.finish);
	const mergedGaps: Array<{ start: number; finish: number }> = [];
	for (const gap of gaps) {
		const previous = mergedGaps.at(-1);
		if (previous && gap.start <= previous.finish) {
			previous.finish = Math.max(previous.finish, gap.finish);
			continue;
		}

		mergedGaps.push({ ...gap });
	}
	summary.gapCount = mergedGaps.length;
	for (const gap of mergedGaps) {
		summary.deadAirSeconds += (gap.finish - gap.start) / 1000;
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
