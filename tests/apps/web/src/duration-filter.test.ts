import { describe, expect, it } from 'vitest';
import { durationFilterDraft, durationFilterError, durationFilterSeconds } from '@web/components/library/duration-filter';
import { catalogProgramItemFilter, catalogProgramItemFilterSummary, catalogProgramQuery, emptyLibraryFilterDraft, libraryFilterDraft } from '@web/components/library/library-filter';

describe('duration filter controls', () => {
	it('distinguishes a blank bound from zero and accepts partial and long durations', () => {
		expect(durationFilterSeconds(durationFilterDraft(null))).toBeNull();
		for (const seconds of [0, 59, 60, 3600, 90061]) {
			expect(durationFilterSeconds(durationFilterDraft(seconds))).toBe(seconds);
		}
		expect(durationFilterSeconds({ hours: '', minutes: '2', seconds: '' })).toBe(120);
	});

	it('rejects invalid components and reversed bounds but accepts equal limits', () => {
		for (const value of [
			{ hours: '-1', minutes: '', seconds: '' },
			{ hours: '1.5', minutes: '', seconds: '' },
			{ hours: 'e', minutes: '', seconds: '' },
			{ hours: '', minutes: '60', seconds: '' },
			{ hours: '', minutes: '', seconds: '60' },
			{ hours: String(Number.MAX_SAFE_INTEGER), minutes: '', seconds: '' },
		]) {
			expect(durationFilterError(value, durationFilterDraft(null))).not.toBe('');
		}
		expect(durationFilterError(durationFilterDraft(61), durationFilterDraft(60))).not.toBe('');
		expect(durationFilterError(durationFilterDraft(60), durationFilterDraft(60))).toBe('');
	});

	it('round-trips bounds through shared drafts, summaries, and recursive selection', () => {
		const draft = { ...emptyLibraryFilterDraft(), minimumDuration: durationFilterDraft(0), maximumDuration: durationFilterDraft(90061) };
		const filter = catalogProgramItemFilter(draft);
		expect(libraryFilterDraft(filter)).toEqual(draft);
		expect(catalogProgramItemFilterSummary(filter)).toContain('Duration: 0h 0m 0s–25h 1m 1s');
		expect(catalogProgramQuery({ page: 1, pageSize: 10, sort: 'title', direction: 'asc', minimumDurationSeconds: 0, maximumDurationSeconds: 90061 }))
			.toMatchObject({ minimumDurationSeconds: 0, maximumDurationSeconds: 90061 });
	});
});
