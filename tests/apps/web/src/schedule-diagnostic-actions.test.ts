import { describe, expect, it } from 'vitest';
import type { TimelineIssue, TimelineSegment } from '@moirai/shared';
import type { DeadAirDiagnostic } from '@web/schedule-diagnostics';
import { deadAirAction } from '@web/schedule-diagnostic-actions';

const segment = {
	templateId: 'outgoing-template',
	slotId: 'slot',
	scheduleLayerId: 'outgoing-layer',
	start: '2026-09-02T01:00:00Z',
	finish: '2026-09-02T01:08:00Z',
} as TimelineSegment;
const issue: TimelineIssue = {
	code: 'source-unavailable',
	message: 'Filler source unavailable.',
	templateId: segment.templateId,
	slotId: segment.slotId,
	scheduleLayerId: segment.scheduleLayerId,
	programId: 'filler-program',
	mediaItemId: null,
	occurrences: [{ start: segment.start, finish: segment.finish, boundaryOrigin: 'layer-entry' }],
};

function diagnostic(overrides: Partial<DeadAirDiagnostic> = {}): DeadAirDiagnostic {
	return { segment, issue, durationSeconds: 480, category: 'filler', fillerOrigin: 'slot', label: '', explanation: '', ...overrides };
}

describe('dead-air editor destinations', () => {
	it.each(['slot', 'template'] as const)('sends %s filler in a conditional layer to its template editor', (fillerOrigin) => {
		expect(deadAirAction(diagnostic({ fillerOrigin }))).toEqual({
			type: 'template', templateId: segment.templateId, label: 'Review filler',
		});
	});

	it('keeps channel filler and program-source actions separate from boundary metadata', () => {
		expect(deadAirAction(diagnostic({ fillerOrigin: 'channel' })).type).toBe('channel-filler');
		expect(deadAirAction(diagnostic({ category: 'source', fillerOrigin: null })))
			.toMatchObject({ type: 'program', programId: issue.programId });
	});

	it('uses the boundary owner and the occurrence overlapping this gap', () => {
		expect(deadAirAction(diagnostic({
			category: 'boundary',
			fillerOrigin: null,
			issue: {
				...issue,
				scheduleLayerId: 'incoming-owner',
				occurrences: [
					{ start: '2026-09-01T01:00:00Z', finish: '2026-09-01T01:08:00Z', boundaryOrigin: 'layer-exit' },
					...issue.occurrences!,
				],
			},
		}))).toEqual({ type: 'layer-boundary', layerId: 'incoming-owner', origin: 'layer-entry', label: 'Review entry boundary' });
	});
});
