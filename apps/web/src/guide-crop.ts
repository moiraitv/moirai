import type { GuideEntry, TimelineSegment } from '@moirai/shared';

/** Show enough context for several short items without shrinking them to the full slot scale. */
export const GUIDE_CROP_MILLISECONDS = 30 * 60 * 1000;

/** Convert a pointer's position across the full block into a clamped time fraction. */
export function guidePointerFraction(clientX: number, left: number, width: number): number {
	return width > 0 ? Math.max(0, Math.min(1, (clientX - left) / width)) : 0.5;
}

/** Clip actual items to a magnified window around the pointed time, bounded by the listing. */
export function guideTimelineCrop(entry: GuideEntry, segments: TimelineSegment[], fraction: number) {
	const blockStart = Date.parse(entry.start);
	const blockFinish = Date.parse(entry.finish);
	const duration = Math.min(GUIDE_CROP_MILLISECONDS, blockFinish - blockStart);
	const center = blockStart + (blockFinish - blockStart) * Math.max(0, Math.min(1, fraction));
	const start = Math.max(blockStart, Math.min(center - duration / 2, blockFinish - duration));
	const finish = start + duration;
	const items = segments.filter((segment) => segment.channelId === entry.channelId
		&& Date.parse(segment.start) < finish && Date.parse(segment.finish) > start)
		.map((segment) => {
			const left = Math.max(start, Date.parse(segment.start));
			const right = Math.min(finish, Date.parse(segment.finish));
			return { segment, left: (left - start) / duration * 100, width: (right - left) / duration * 100 };
		});
	return { start, finish, center, marker: (center - start) / duration * 100, items };
}
