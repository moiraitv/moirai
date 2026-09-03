import { describe, expect, it } from 'vitest';
import { MAX_TIMELINE_SEGMENTS } from '@moirai/shared';
import { publicError } from '@server/routes/public-errors.js';
import { TimelineMaterializationLimitError } from '@server/scheduling/engine.js';
import { TimelineIssueLimitError } from '@server/scheduling/timeline-issues.js';
import { schedulingWorkerError } from '@server/scheduling/worker-pool.js';

describe('scheduling worker error transport', () => {
	it('restores diagnostic count limits for actionable public errors', () => {
		const error = schedulingWorkerError({
			name: 'TimelineIssueLimitError',
			message: 'serialized worker message',
			statusCode: 422,
		});

		expect(error).toBeInstanceOf(TimelineIssueLimitError);
		expect(publicError(error, 'diagnostics-request')).toMatchObject({
			statusCode: 422,
			body: { code: 'request_failed', requestId: 'diagnostics-request' },
			expected: true,
		});
	});

	it('restores materialization limit errors for public 422 mapping', () => {
		const error = schedulingWorkerError({
			name: 'TimelineMaterializationLimitError',
			message: 'serialized worker message',
			statusCode: 422,
			limit: MAX_TIMELINE_SEGMENTS,
		});

		expect(error).toBeInstanceOf(TimelineMaterializationLimitError);
		expect(error).toMatchObject({ limit: MAX_TIMELINE_SEGMENTS, statusCode: 422 });
		expect(publicError(error, 'worker-request')).toMatchObject({
			statusCode: 422,
			body: { code: 'request_failed', requestId: 'worker-request' },
			expected: true,
		});
	});
});
