import { z } from 'zod';
import { subtitlePreferencesSchema } from './subtitles.js';

/** Bound hypothetical inheritance contexts without traversing every program usage. */
export const MAX_SUBTITLE_PREVIEW_ANCESTORS = 64;
/** Authored snapshots support checking unsaved rules without changing saved resources. */
export const subtitleSelectionPreviewSchema = z.object({
	mediaItemId: z.uuid(),
	channelPreferences: subtitlePreferencesSchema,
	programPreferences: z.array(subtitlePreferencesSchema).max(MAX_SUBTITLE_PREVIEW_ANCESTORS + 1),
}).strict();
/** Reasons an indexed track cannot satisfy the effective selection rules. */
export const subtitleRejectionReasonSchema = z.enum(['off', 'part', 'language', 'title', 'forced']);
/** Public track details exclude filesystem paths and subtitle contents. */
export const subtitlePreviewTrackSchema = z.object({
	id: z.string(), sourceType: z.enum(['embedded', 'sidecar']), partNumber: z.number().int().nullable(),
	streamIndex: z.number().int().nullable(), codec: z.string().nullable(), format: z.string().nullable(),
	language: z.string().nullable(), title: z.string().nullable(), isDefault: z.boolean(), isForced: z.boolean(),
	isHearingImpaired: z.boolean(), isCommentary: z.boolean(),
});
/** Metadata-only results retain ranking and every applicable rejection reason per part. */
export const subtitleSelectionPreviewResultSchema = z.object({
	mediaItemId: z.uuid(), title: z.string(), preferences: subtitlePreferencesSchema,
	limitations: z.array(z.string()),
	parts: z.array(z.object({
		number: z.number().int(), outcome: z.enum(['off', 'credits', 'selected', 'no-match']),
		selectedTrackId: z.string().nullable(),
		tracks: z.array(z.object({
			track: subtitlePreviewTrackSchema, rank: z.number().int().positive().nullable(),
			rejectionReasons: z.array(subtitleRejectionReasonSchema),
		})),
	})),
});
/** Request to inspect one video using explicit preference layers. */
export type SubtitleSelectionPreview = z.infer<typeof subtitleSelectionPreviewSchema>;
/** Result before file probing, preparation, or rendering. */
export type SubtitleSelectionPreviewResult = z.infer<typeof subtitleSelectionPreviewResultSchema>;
/** One eligibility failure shared by preview and playback. */
export type SubtitleRejectionReason = z.infer<typeof subtitleRejectionReasonSchema>;
