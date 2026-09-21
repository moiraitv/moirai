/** Minimum remaining width reserved for title, subtitle, and timespan. */
export const GUIDE_LISTING_TEXT_MIN_PX = 120;
/** Inner height of a Guide programme after vertical inset. */
export const GUIDE_PROGRAMME_INNER_HEIGHT_PX = 88;
/** Horizontal padding of listing copy, including the space after a flush thumbnail. */
export const GUIDE_LISTING_PAD_X_PX = 12;
/** Gap between the thumbnail and listing copy. */
export const GUIDE_LISTING_THUMB_GAP_PX = 12;
/** Inset from each timed edge so adjacent Guide cards do not share a border. */
export const GUIDE_LISTING_GUTTER_PX = 3;

/** Chosen left thumbnail for a Guide listing. */
export type GuideListingThumb = { kind: 'landscape' | 'poster'; url: string };

/** Shrink a timed span so Guide listings paint with a small gutter. */
export function guideListingVisualWidth(spanWidth: number): number {
	const inset = GUIDE_LISTING_GUTTER_PX * 2;
	return spanWidth > inset + 3 ? spanWidth - inset : spanWidth;
}

/** Pick a square landscape, 2:3 poster, or omitted thumb so listing text keeps a readable width. */
export function guideListingThumb(
	listingWidth: number,
	landscapeUrl: string | null | undefined,
	posterUrl: string | null | undefined,
): GuideListingThumb | null {
	const inner = listingWidth - GUIDE_LISTING_PAD_X_PX - GUIDE_LISTING_THUMB_GAP_PX;
	const landscapeWidth = GUIDE_PROGRAMME_INNER_HEIGHT_PX;
	const posterWidth = GUIDE_PROGRAMME_INNER_HEIGHT_PX * (2 / 3);
	if ((landscapeUrl || posterUrl) && inner - landscapeWidth >= GUIDE_LISTING_TEXT_MIN_PX) {
		return { kind: 'landscape', url: landscapeUrl || posterUrl! };
	}
	if (posterUrl && inner - posterWidth >= GUIDE_LISTING_TEXT_MIN_PX) {
		return { kind: 'poster', url: posterUrl };
	}

	return null;
}

/** Prefer fanart for the right-side wash, then landscape when no fanart file exists. */
export function guideListingWashUrl(
	fanartUrl: string | null | undefined,
	landscapeUrl: string | null | undefined,
): string | null {
	return fanartUrl || landscapeUrl || null;
}

/** Last-used formatter; bounded to one zone rather than one allocation per listing. */
let listingFormatter: { timeZone: string; format: Intl.DateTimeFormat } | undefined;

/** Format a listing interval as 24-hour hours and minutes without a time zone. */
export function guideListingTimespan(start: string, finish: string, timeZone: string): string {
	if (listingFormatter?.timeZone !== timeZone) {
		listingFormatter = { timeZone, format: new Intl.DateTimeFormat('en-GB', {
			hour: '2-digit',
			minute: '2-digit',
			hour12: false,
			timeZone,
		}) };
	}
	const format = listingFormatter.format;
	return `${format.format(new Date(start))}–${format.format(new Date(finish))}`;
}
