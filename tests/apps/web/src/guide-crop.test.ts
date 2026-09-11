import { describe, expect, it } from 'vitest';
import type { GuideEntry, TimelineSegment } from '@moirai/shared';
import { GUIDE_CROP_MILLISECONDS, guidePointerFraction, guideTimelineCrop } from '../../../../apps/web/src/guide-crop';

const start = Date.parse('2026-09-10T08:00:00Z');
const entry = {
	channelId: 'music', start: new Date(start).toISOString(), finish: new Date(start + 3_600_000).toISOString(),
} as GuideEntry;

function segment(from: number, to: number, channelId = 'music'): TimelineSegment {
	return { id: `${from}`, channelId, start: new Date(start + from * 60_000).toISOString(),
		finish: new Date(start + to * 60_000).toISOString(), title: `Video ${from}` } as TimelineSegment;
}

describe('guide timeline crop', () => {
	it('maps pointer positions across a scrolled block and clamps outside its bounds', () => {
		expect(guidePointerFraction(100, -200, 600)).toBe(0.5);
		expect(guidePointerFraction(-300, -200, 600)).toBe(0);
		expect(guidePointerFraction(500, -200, 600)).toBe(1);
		expect(guidePointerFraction(100, 0, 0)).toBe(0.5);
	});

	it('centers a zoomed window and clips items while preserving their original identities and times', () => {
		const items = [segment(10, 20), segment(20, 30), segment(30, 50), segment(50, 55), segment(20, 30, 'other')];
		const before = structuredClone(items);
		const crop = guideTimelineCrop(entry, items, 0.5);
		expect(crop.finish - crop.start).toBe(GUIDE_CROP_MILLISECONDS);
		expect(crop.center).toBe(start + 30 * 60_000);
		expect(crop.marker).toBe(50);
		expect(crop.items.map((item) => item.segment)).toEqual(items.slice(0, 3));
		expect(crop.items[0]?.left).toBe(0);
		expect(crop.items[0]?.width).toBeCloseTo(100 / 6);
		expect(crop.items.at(-1)!.left + crop.items.at(-1)!.width).toBe(100);
		expect(items).toEqual(before);
	});

	it('keeps edge windows inside the block and excludes items that only touch a boundary', () => {
		const left = guideTimelineCrop(entry, [segment(-5, 0), segment(0, 5), segment(30, 35)], 0);
		expect(left.start).toBe(start);
		expect(left.items).toHaveLength(1);
		const right = guideTimelineCrop(entry, [], 1);
		expect(right.finish).toBe(Date.parse(entry.finish));
		expect(right.marker).toBe(100);
	});

	it('shows an entire short slot and includes content drifting into it', () => {
		const short = { ...entry, finish: new Date(start + 5 * 60_000).toISOString() };
		const crop = guideTimelineCrop(short, [segment(-2, 7)], 0.2);
		expect(crop.start).toBe(start);
		expect(crop.finish).toBe(Date.parse(short.finish));
		expect(crop.items[0]).toMatchObject({ left: 0, width: 100 });
	});
});
