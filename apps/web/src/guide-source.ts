import type { TimelineSegment } from '@moirai/shared';

/** Label scheduled content by its source while keeping filler and gaps distinct. */
export function guideSourceLabel(segment: Pick<TimelineSegment, 'role' | 'programId'>, names: Record<string, string>): string {
	if (segment.role === 'filler') {
		return 'Filler';
	}
	if (segment.role === 'dead-air') {
		return 'Gap';
	}
	return segment.programId ? names[segment.programId] ?? 'Missing program' : 'Scheduled content';
}
