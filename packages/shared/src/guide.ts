import { z } from 'zod';

/** Bound XMLTV descriptions and authored slot descriptions. */
export const MAX_XMLTV_DESCRIPTION_LENGTH = 4 * 1024;

/** Maximum encoded and normalized guide artwork size. */
export const GUIDE_ARTWORK_MAX_BYTES = 10 * 1024 * 1024;
/** Maximum width or height of a guide artwork upload. */
export const GUIDE_ARTWORK_MAX_DIMENSION = 4096;
/** Accepted raster formats for custom block artwork. */
export const GUIDE_ARTWORK_CONTENT_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
/** Immutable managed image returned after a successful upload. */
export const guideArtworkUploadSchema = z.object({ artworkId: z.uuid() });

/** Resolve an immutable managed block image without exposing storage paths. */
export function guideArtworkUrl(artworkId: string): string {
	return `/api/v1/guide-artwork/${encodeURIComponent(artworkId)}`;
}

/** Optional slot presentation; absence preserves individual listings; blank block titles use the program name. */
export const slotGuideSchema = z.discriminatedUnion('mode', [
	z.object({ mode: z.literal('items') }),
	z.object({
		mode: z.literal('block'),
		artworkId: z.uuid().optional(),
		title: z.string().trim().max(120).default(''),
		description: z.string().trim().max(MAX_XMLTV_DESCRIPTION_LENGTH).default(''),
		boundary: z.enum(['scheduled', 'drift']).default('scheduled'),
	}),
]);

/** Presentation-only listing with an optional committed media detail target. */
export const guideEntrySchema = z.object({
	id: z.string(),
	channelId: z.uuid(),
	kind: z.enum(['item', 'block']),
	start: z.iso.datetime({ offset: true }),
	finish: z.iso.datetime({ offset: true }),
	title: z.string(),
	subtitle: z.string().optional(),
	description: z.string(),
	programId: z.uuid().nullable(),
	segmentId: z.uuid().nullable(),
	occurrenceId: z.string().nullable(),
	role: z.enum(['primary', 'filler', 'dead-air']),
	truncated: z.boolean(),
	posterUrl: z.string().nullable().optional(),
	landscapeUrl: z.string().nullable().optional(),
	fanartUrl: z.string().nullable().optional(),
});

/** A display interval that never changes its source playback segment. */
export type GuideEntry = z.infer<typeof guideEntrySchema>;

/** Committed effective slot interval, including slots displaced entirely by prior content. */
export interface GuideOccurrence {
	id: string;
	templateId: string;
	slotId: string;
	scheduleLayerId: string | null;
	programId: string | null;
	start: string;
	finish: string;
	actualStart: string | null;
	actualFinish: string | null;
}
