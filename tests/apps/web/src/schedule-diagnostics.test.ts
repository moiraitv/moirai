import { describe, expect, it } from 'vitest';
import type { ChannelScheduleConfig, ScheduleTemplate, TimelinePreview } from '@moirai/shared';
import {
	deadAirDiagnostics,
	schedulingDurationLabel,
	totalDeadAirSeconds,
} from '@web/schedule-diagnostics';
import { deadAirAction } from '@web/schedule-diagnostic-actions';

const schedule: ChannelScheduleConfig = {
	defaultTemplateId: 'template',
	layers: [],
	defaultFiller: null,
};
const template = {
	id: 'template',
	defaultFiller: null,
	slots: [
		{ id: 'authored', programId: null, filler: { mode: 'disabled' } },
		{ id: 'boundary', programId: 'program', filler: { mode: 'inherit' } },
	],
} as ScheduleTemplate;
const preview = {
	segments: [
		{
			id: 'dead-air-12',
			role: 'dead-air',
			templateId: 'template',
			scheduleLayerId: 'layer',
			slotId: 'boundary',
			start: '2026-09-02T19:59:48Z',
			finish: '2026-09-02T20:00:00Z',
		},
		{
			id: 'authored-8-minutes',
			role: 'dead-air',
			templateId: 'template',
			scheduleLayerId: null,
			slotId: 'authored',
			start: '2026-09-02T20:00:00Z',
			finish: '2026-09-02T20:08:00Z',
		},
	],
	issues: [{
		code: 'boundary-start-rejected',
		message: 'No outgoing item can finish within the configured late drift.',
		templateId: 'template',
		scheduleLayerId: 'layer',
		slotId: 'boundary',
		programId: 'program',
		mediaItemId: null,
		occurrenceCount: 1,
		occurrences: [{
			start: '2026-09-02T19:59:48Z',
			finish: '2026-09-02T20:00:00Z',
			boundaryOrigin: 'layer-entry',
		}],
	}],
} as TimelinePreview;

describe('schedule dead-air diagnostics', () => {
	it.each(['template', 'layer-entry', 'layer-exit'] as const)('prioritizes the %s gap rejection over an earlier skipped-media warning', (origin) => {
		const gap = { ...preview.segments[0]!, start: '2026-09-02T19:00:00Z' };
		const boundaryIssue = {
			...preview.issues[0]!,
			mediaItemId: 'healthy-90-minute-item',
			occurrences: [{ start: gap.start, finish: gap.finish, boundaryOrigin: origin }],
		};
		const mediaIssue = {
			...boundaryIssue,
			code: 'media-duration-missing',
			message: 'Skipped an unprobed item because it has no usable duration.',
			mediaItemId: 'unprobed-item',
			occurrences: [{ start: gap.start, finish: null, boundaryOrigin: origin }],
		};
		const [diagnostic] = deadAirDiagnostics({
			...preview, segments: [gap], issues: [mediaIssue, boundaryIssue],
		}, [template], schedule);

		expect(diagnostic).toMatchObject({ category: 'boundary', explanation: boundaryIssue.message });
		expect(diagnostic?.issue).toBe(boundaryIssue);
		expect(deadAirAction(diagnostic!)).toMatchObject(origin === 'template'
			? { type: 'template', templateId: template.id }
			: { type: 'layer-boundary', layerId: boundaryIssue.scheduleLayerId, origin });
	});

	it.each([
		{ slotId: 'another-slot' },
		{ templateId: 'another-template' },
		{ occurrences: [{ start: '2026-09-02T20:00:00Z', finish: '2026-09-02T21:00:00Z', boundaryOrigin: 'template' as const }] },
	])('retains source diagnostics when a boundary warning does not match the gap: %j', (unrelated) => {
		const gap = preview.segments[0]!;
		const sourceIssue = {
			...preview.issues[0]!,
			code: 'source-unavailable',
			message: 'The program source is unavailable.',
			occurrences: [{ start: gap.start, finish: null, boundaryOrigin: 'template' as const }],
		};
		const [diagnostic] = deadAirDiagnostics({
			...preview, segments: [gap], issues: [sourceIssue, { ...preview.issues[0]!, ...unrelated }],
		}, [template], schedule);

		expect(diagnostic).toMatchObject({ category: 'source', explanation: sourceIssue.message });
		expect(diagnostic?.issue).toBe(sourceIssue);
		expect(deadAirAction(diagnostic!)).toMatchObject({ type: 'program', programId: sourceIssue.programId });
	});

	it('routes unused time in a programmed slot with filler disabled to its template, even when channel filler exists', () => {
		const disabled = { ...template, slots: template.slots.map((slot) => ({ ...slot, filler: { mode: 'disabled' as const } })) };
		const [diagnostic] = deadAirDiagnostics({ ...preview, segments: [preview.segments[0]!], issues: [] }, [disabled], {
			...schedule, defaultFiller: { programId: 'channel-filler', policy: 'best-fit-only' },
		});
		expect(diagnostic).toMatchObject({ category: 'unfilled', slotFillerDisabled: true });
		expect(deadAirAction(diagnostic!)).toEqual({ type: 'template', templateId: template.id, label: 'Review filler' });
	});

	it('matches fractional-second warning instants to gaps beginning at a whole second', () => {
		const [diagnostic] = deadAirDiagnostics({
			...preview,
			segments: [{ ...preview.segments[0]!, start: '2026-09-02T00:00:00Z', finish: '2026-09-02T00:00:01Z' }],
			issues: [{ ...preview.issues[0]!, occurrences: [{ start: '2026-09-02T00:00:00.5Z', finish: null, boundaryOrigin: 'layer-entry' }] }],
		}, [template], schedule);
		expect(diagnostic?.category).toBe('boundary');
		expect(deadAirAction(diagnostic!).type).toBe('layer-boundary');
	});

	it('keeps tiny gaps exact while formatting longer mixed durations', () => {
		expect(schedulingDurationLabel(12)).toBe('12 seconds');
		expect(schedulingDurationLabel(492)).toBe('8m 12s');
	});

	it('distinguishes a boundary failure from an authored off-air interval', () => {
		const diagnostics = deadAirDiagnostics(preview, [template], schedule);

		expect(diagnostics.map((diagnostic) => ({
			id: diagnostic.segment.id,
			category: diagnostic.category,
			durationSeconds: diagnostic.durationSeconds,
		}))).toEqual([
			{ id: 'dead-air-12', category: 'boundary', durationSeconds: 12 },
			{ id: 'authored-8-minutes', category: 'authored', durationSeconds: 480 },
		]);
		expect(diagnostics[0]?.explanation).toContain('configured late drift');
		expect(diagnostics[1]?.explanation).toContain('intentionally');
		expect(totalDeadAirSeconds(preview)).toBe(492);
	});

	it('classifies an uncovered no-program slot as a channel filler failure when filler is inherited', () => {
		const scheduleWithFiller: ChannelScheduleConfig = {
			...schedule,
			defaultFiller: {
				programId: '00000000-0000-4000-8000-000000000099',
				policy: 'best-fit-or-truncate',
			},
		};
		const [diagnostic] = deadAirDiagnostics({
			...preview,
			segments: [preview.segments[1]!],
			issues: [],
		}, [template], scheduleWithFiller);

		expect(diagnostic).toMatchObject({
			category: 'filler',
			label: 'Channel filler could not cover the interval',
			fillerOrigin: 'channel',
		});
		expect(diagnostic?.explanation).toContain('channel filler');
	});
});
