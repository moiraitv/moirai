import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { Temporal } from '@js-temporal/polyfill';
import { scheduleTemplateCreateSchema, SECONDS_PER_SCHEDULING_DAY, type TimelineSegment } from '@moirai/shared';
import type { Repository } from '@server/repository/index.js';
import { readCommittedScheduleGuide } from '@server/guide/schedule-guide.js';
import { boundedProjectedWindow, GuideMaterializationLimitError } from '@server/guide/window.js';
import { itemGuideEntry } from '@server/guide/projection.js';

vi.mock('@moirai/shared', async (importOriginal) => ({
	...await importOriginal<typeof import('@moirai/shared')>(), MAX_GUIDE_TIMELINE_SEGMENTS: 4,
}));
afterEach(() => vi.useRealTimers());

it.each([false, true])('bounds projected splits across channels (first-day overflow: %s)', async (firstDay) => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date('2026-08-23T12:00:00Z'));
	const start = '2026-08-23T00:00:00Z';
	const finish = '2026-08-25T00:00:00Z';
	const midnight = '2026-08-24T00:00:00Z';
	const slotId = randomUUID();
	const template = {
		...scheduleTemplateCreateSchema.parse({ name: 'Music', slots: [{ id: slotId, startSeconds: 0,
			programId: null, filler: { mode: 'disabled' }, guide: { mode: 'block', title: 'Music' } }],
		boundaries: [{ id: randomUUID(), leftSlotId: slotId, rightSlotId: slotId, targetSeconds: SECONDS_PER_SCHEDULING_DAY, policy: 'hard' }],
		}), id: randomUUID(), createdAt: start, updatedAt: start,
	};
	const channels = [randomUUID(), randomUUID()];
	const segments = channels.map((channelId): TimelineSegment => ({
		id: randomUUID(), channelId, templateId: template.id, slotId, programId: null, scheduleLayerId: null,
		start, finish, title: 'Long item', role: 'dead-air', truncated: false,
		mediaItemId: null, playbackPath: null, sourceStartSeconds: 0, sourceFinishSeconds: null,
	}));
	const day = firstDay ? '2026-08-23' : '2026-08-24';
	const repository = {
		listChannelSchedules: vi.fn().mockResolvedValue(channels.map((channelId) => ({ channelId, defaultTemplateId: template.id }))),
		listMaterializedTimelineSegmentsForGuide: vi.fn().mockResolvedValue(segments.map((segment) => ({ segment, mediaSnapshot: null }))),
		getSchedulingCatalog: vi.fn().mockResolvedValue({ media: [] }),
		listScheduleTemplates: vi.fn().mockResolvedValue([template]),
		listTimelineMaterializations: vi.fn().mockResolvedValue(channels.map((channelId) => ({
			channelId, health: 'ready', committedAt: start, windowStart: start, windowEnd: finish,
			issues: [{ code: 'gap', message: 'Later gap', templateId: template.id, slotId, programId: null,
				mediaItemId: null, scheduleLayerId: null, occurrences: [{ start: `${day}T01:00:00Z`, finish: `${day}T02:00:00Z`, boundaryOrigin: 'template' }] }],
			guideOccurrences: [{ id: randomUUID(), templateId: template.id, slotId, programId: null, scheduleLayerId: null,
				start: `${day}T01:00:00Z`, finish: `${day}T02:00:00Z`, actualStart: null, actualFinish: null }],
		}))),
	} as unknown as Repository;

	const result = readCommittedScheduleGuide(repository, 'UTC', '2026-08-23', 2);
	if (firstDay) {
		await expect(result).rejects.toBeInstanceOf(GuideMaterializationLimitError);
		return;
	}
	const { guide } = await result;
	expect(guide).toMatchObject({ days: 1, requestedDays: 2, segmentLimitApplied: true });
	for (const channel of guide.channels) {
		expect(channel.entries).toMatchObject([{ start, finish: midnight, title: 'Long item' }]);
		expect(channel.preview).toMatchObject({ days: 1, issues: [] });
		expect(channel.preview.segments[0]?.finish).toBe(finish);
	}
	expect(repository.listMaterializedTimelineSegmentsForGuide).toHaveBeenCalledTimes(1);
});

it('chooses local midnight on a DST day, and accepts the exact limit', () => {
	const entries = ['2026-03-08T08:00:00Z', '2026-03-09T06:00:00Z', '2026-03-09T07:00:00Z']
		.map((start) => itemGuideEntry({ start } as TimelineSegment));
	const from = Temporal.PlainDate.from('2026-03-08');
	const to = from.add({ days: 2 });
	expect(boundedProjectedWindow(from, to, 'America/Los_Angeles', entries, 2)).toMatchObject({ days: 1, segmentLimitApplied: true });
	expect(boundedProjectedWindow(from, to, 'America/Los_Angeles', entries, 3)).toMatchObject({ days: 2, segmentLimitApplied: false });
});
