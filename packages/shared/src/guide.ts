import { z } from 'zod';

/** Bound XMLTV descriptions and authored slot descriptions. */
export const MAX_XMLTV_DESCRIPTION_LENGTH = 4 * 1024;

/** Optional slot presentation; absence preserves individual listings; blank block titles use the program name. */
export const slotGuideSchema = z.discriminatedUnion('mode', [
	z.object({ mode: z.literal('items') }),
	z.object({
		mode: z.literal('block'),
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
	description: z.string(),
	programId: z.uuid().nullable(),
	segmentId: z.uuid().nullable(),
	occurrenceId: z.string().nullable(),
	role: z.enum(['primary', 'filler', 'dead-air']),
	truncated: z.boolean(),
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
