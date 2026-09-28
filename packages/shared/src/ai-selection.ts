import { z } from 'zod';

/** Whether an OpenAI-compatible content model is configured on the server. */
export const aiStatusSchema = z.object({ configured: z.boolean() });
/** Shared wire contract for AI availability. */
export type AiStatus = z.infer<typeof aiStatusSchema>;

/** Five requested result ceilings; generation may return fewer confident matches. */
export const AI_RESULT_COUNTS = [50, 100, 150, 200, 250] as const;
/** Default ceiling balances selection breadth with review effort. */
export const AI_DEFAULT_RESULT_COUNT = 100;
/** Validate the five supported result-count choices. */
export const aiResultCountSchema = z.union([
	z.literal(50), z.literal(100), z.literal(150), z.literal(200), z.literal(250),
]);
/** Supported maximum for one AI selection request. */
export type AiResultCount = z.infer<typeof aiResultCountSchema>;

/** Prompt and library used to freeze one AI content selection. */
export const aiContentSelectionRequestSchema = z.object({
	libraryId: z.uuid(),
	prompt: z.string().trim().min(1).max(2_000),
	maxResults: aiResultCountSchema.optional(),
});
/** Shared wire contract for an AI content-selection request. */
export type AiContentSelectionRequest = z.infer<typeof aiContentSelectionRequestSchema>;

/** Titles the model returned that could not be matched to the library. */
export const aiUnmatchedTitleSchema = z.object({
	title: z.string(),
	year: z.number().int().nullable(),
});

/** Coverage of one approximate AI generation, independent of saved manual exclusions. */
export const aiSelectionCoverageSchema = z.object({
	libraryCount: z.number().int().nonnegative(),
	reviewedCount: z.number().int().nonnegative(),
	shortlistLimited: z.boolean(),
	embeddingsAvailable: z.boolean(),
	mediaEmbeddingsAvailable: z.boolean().optional(),
	queryEmbeddingsAvailable: z.boolean().optional(),
	searchBudgetExhausted: z.boolean(),
});
/** Public coverage metadata for one completed generation. */
export type AiSelectionCoverage = z.infer<typeof aiSelectionCoverageSchema>;

/** Frozen library matches produced by one Generate action. */
export const aiContentSelectionResponseSchema = z.object({
	itemIds: z.array(z.uuid()),
	unmatched: z.array(aiUnmatchedTitleSchema),
	catalogTruncated: z.boolean(),
	coverage: aiSelectionCoverageSchema.optional(),
});
/** Shared wire contract for an AI content-selection response. */
export type AiContentSelectionResponse = z.infer<typeof aiContentSelectionResponseSchema>;
