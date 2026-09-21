/** Editable components for one optional whole-second duration bound. */
export interface DurationFilterDraft {
	hours: string;
	minutes: string;
	seconds: string;
}

/** Split a persisted bound without imposing a time-of-day limit on hours. */
export function durationFilterDraft(seconds: number | null | undefined): DurationFilterDraft {
	return seconds == null
		? { hours: '', minutes: '', seconds: '' }
		: { hours: String(Math.floor(seconds / 3600)), minutes: String(Math.floor(seconds % 3600 / 60)), seconds: String(seconds % 60) };
}

/** Return null for an unrestricted bound and NaN for invalid authored components. */
export function durationFilterSeconds(draft: DurationFilterDraft): number | null {
	const values = [draft.hours, draft.minutes, draft.seconds];
	if (values.every(value => value === '')) {
		return null;
	}
	if (values.some(value => value !== '' && !/^\d+$/.test(value))) {
		return NaN;
	}

	const [hours, minutes, seconds] = values.map(Number) as [number, number, number];
	const total = hours * 3600 + minutes * 60 + seconds;
	return minutes <= 59 && seconds <= 59 && Number.isSafeInteger(total) ? total : NaN;
}

/** Explain invalid components or reversed bounds before the filter can be applied. */
export function durationFilterError(minimum: DurationFilterDraft, maximum: DurationFilterDraft): string {
	const min = durationFilterSeconds(minimum);
	const max = durationFilterSeconds(maximum);
	if (Number.isNaN(min) || Number.isNaN(max)) {
		return 'Enter whole, nonnegative hours and minutes/seconds from 0 to 59, within the supported duration range.';
	}
	return min != null && max != null && min > max
		? 'Maximum duration must be at least minimum duration.' : '';
}

/** Preserve second-level precision in filter summaries, including an explicit zero bound. */
export function durationFilterLabel(seconds: number): string {
	const parts = durationFilterDraft(seconds);
	return `${parts.hours}h ${parts.minutes}m ${parts.seconds}s`;
}
