import { z } from 'zod';
import { mediaAvailabilitySchema } from './availability.js';
import { semanticProgramConfigSchema } from './scheduling.js';
import { excludedItemIdsSchema, MAX_EXCLUDED_MEDIA_ITEMS } from './item-exclusions.js';

/** Original review settings plus later removals, without committing a scheduling set. */
export const semanticMatchesRequestSchema = z.object({
	config: semanticProgramConfigSchema,
	/** New removals applied after ranking against the original configuration's relevance pool. */
	additionalExcludedItemIds: excludedItemIdsSchema.optional(),
	search: z.string().trim().max(200).default(''),
	cursor: z.string().regex(/^\d+$/u).nullable().default(null),
	limit: z.number().int().min(1).max(200).default(100),
}).refine(
	(input) => new Set([...input.config.excludedItemIds ?? [], ...input.additionalExcludedItemIds ?? []]).size <= MAX_EXCLUDED_MEDIA_ITEMS,
	{ path: ['additionalExcludedItemIds'], message: 'Combined removals exceed the program removal limit' },
);
/** Validated review page request. */
export type SemanticMatchesRequest = z.infer<typeof semanticMatchesRequestSchema>;

/** Compact cards for one page of the complete currently prepared matching pool. */
export const semanticMatchesResponseSchema = z.object({
	items: z.array(z.object({
		id: z.uuid(), libraryId: z.uuid(), title: z.string(), year: z.number().nullable(),
		artworkUrl: z.string().nullable(), availability: mediaAvailabilitySchema,
	})),
	total: z.number().int().nonnegative(),
	nextCursor: z.string().nullable(),
	pending: z.boolean(),
	preparationFailed: z.boolean(),
	message: z.string(),
});
/** Matching pool page with preparation state. */
export type SemanticMatchesResponse = z.infer<typeof semanticMatchesResponseSchema>;
