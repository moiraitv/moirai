import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MAX_TIMELINE_SEGMENTS, XMLTV_EPG_DAYS } from '@moirai/shared';
import { createDatabase } from '@server/db/index.js';
import { Repository } from '@server/repository/index.js';
import { publicError } from '@server/routes/public-errors.js';
import { TimelineMaterializationLimitError } from '@server/scheduling/engine.js';
import { TimelineIssueLimitError } from '@server/scheduling/timeline-issues.js';
import { SchedulingWorkerPool, schedulingWorkerError } from '@server/scheduling/worker-pool.js';

it('keeps capacity reserved by declining speculative guide reads with one worker or an occupied spare', async () => {
	const directory = await mkdtemp(path.join(tmpdir(), 'moirai-snapshot-capacity-'));
	const database = createDatabase(path.join(directory, 'first-day.sqlite'), path.resolve('drizzle'));
	const repository = new Repository(database.db);
	const single = new SchedulingWorkerPool(1, 4, { db: database.db, repository });
	const dual = new SchedulingWorkerPool(2, 4, { db: database.db, repository });
	const request = { kind: 'guide', startDate: new Date().toISOString().slice(0, 10), days: 1,
		guideDays: XMLTV_EPG_DAYS, timeZone: 'UTC', publicUrl: 'http://localhost', snapshot: true } as const;
	try {
		expect(await single.warmGuide(request)).toBeUndefined();
		const running = dual.warmGuide(request);
		void running.catch(() => undefined);
		expect(await dual.warmGuide(request)).toBeUndefined();
		expect(await running).toMatchObject({ snapshotKey: expect.any(String) });
	}
	finally {
		await Promise.all([single.close(), dual.close()]);
		database.close();
		await rm(directory, { recursive: true, force: true });
	}
}, 20_000);

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
