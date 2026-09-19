import { expect, it } from 'vitest';
import {
	GUIDE_LISTING_GUTTER_PX,
	GUIDE_LISTING_PAD_X_PX,
	GUIDE_LISTING_TEXT_MIN_PX,
	GUIDE_LISTING_THUMB_GAP_PX,
	GUIDE_PROGRAMME_INNER_HEIGHT_PX,
	guideListingThumb,
	guideListingTimespan,
	guideListingVisualWidth,
	guideListingWashUrl,
} from '@web/guide-listing-layout.js';

it('prefers a square landscape thumb, then 2:3, then omits when text would clip', () => {
	const chrome = GUIDE_LISTING_PAD_X_PX + GUIDE_LISTING_THUMB_GAP_PX;
	const landscapeWidth = GUIDE_PROGRAMME_INNER_HEIGHT_PX;
	const posterWidth = GUIDE_PROGRAMME_INNER_HEIGHT_PX * (2 / 3);
	expect(guideListingThumb(
		chrome + landscapeWidth + GUIDE_LISTING_TEXT_MIN_PX + 8,
		'/landscape',
		'/poster',
	)).toEqual({ kind: 'landscape', url: '/landscape' });
	expect(guideListingThumb(
		chrome + landscapeWidth + GUIDE_LISTING_TEXT_MIN_PX + 8,
		null,
		'/poster',
	)).toEqual({ kind: 'landscape', url: '/poster' });
	expect(guideListingThumb(
		chrome + posterWidth + GUIDE_LISTING_TEXT_MIN_PX + 8,
		'/landscape',
		'/poster',
	)).toEqual({ kind: 'poster', url: '/poster' });
	expect(guideListingThumb(
		chrome + posterWidth + GUIDE_LISTING_TEXT_MIN_PX - 8,
		'/landscape',
		'/poster',
	)).toBeNull();
});

it('insets wide listings without shrinking the 3px minimum bar', () => {
	expect(guideListingVisualWidth(200)).toBe(200 - GUIDE_LISTING_GUTTER_PX * 2);
	expect(guideListingVisualWidth(3)).toBe(3);
});

it('uses landscape for the right-side wash when fanart is missing', () => {
	expect(guideListingWashUrl('/fanart', '/landscape')).toBe('/fanart');
	expect(guideListingWashUrl(null, '/landscape')).toBe('/landscape');
	expect(guideListingWashUrl(null, null)).toBeNull();
});

it('formats listing times without seconds, timezone, or AM/PM', () => {
	expect(guideListingTimespan(
		'2026-09-18T16:05:30.000Z',
		'2026-09-18T18:22:59.000Z',
		'UTC',
	)).toBe('16:05–18:22');
});
