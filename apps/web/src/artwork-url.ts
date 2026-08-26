/** Density-aware artwork variants exposed by the UI cache endpoint. */
export type UiArtworkVariant = 'thumb' | 'card' | 'detail';

/** Preserve cache-version parameters while selecting a bounded server-rendered variant. */
export function artworkVariantUrl(
	value: string | null | undefined,
	variant: UiArtworkVariant,
	density = 1,
): string | undefined {
	if (!value) {
		return undefined;
	}

	const url = new URL(value, window.location.origin);
	url.searchParams.set('variant', variant);
	url.searchParams.set('dpr', String(density));
	return `${url.pathname}${url.search}`;
}

/** Build 1x, 2x, and 3x URLs for a bounded artwork variant. */
export function artworkSrcset(
	value: string | null | undefined,
	variant: UiArtworkVariant,
): string | undefined {
	if (!value) {
		return undefined;
	}

	return ([1, 2, 3] as const)
		.map((density) => `${artworkVariantUrl(value, variant, density)} ${density}x`)
		.join(', ');
}
