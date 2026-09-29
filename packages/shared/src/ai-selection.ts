import { z } from 'zod';

/** Whether an OpenAI-compatible content model is configured on the server. */
export const aiStatusSchema = z.object({ configured: z.boolean() });
/** Shared wire contract for AI availability. */
export type AiStatus = z.infer<typeof aiStatusSchema>;

/** Provider profiles available in administrator Settings. */
export const aiProviderSchema = z.enum(['openai', 'anthropic', 'xai', 'openrouter', 'custom']);
/** Stable provider identifier. */
export type AiProvider = z.infer<typeof aiProviderSchema>;
/** Supported hard deadlines for web-research generations, in minutes. */
export const aiWebSearchTimeLimitSchema = z.union([z.literal(5), z.literal(7), z.literal(10), z.literal(15)]);
/** Default hard deadline allows in-flight research to finish after the three-minute target. */
export const AI_WEB_SEARCH_DEFAULT_TIME_LIMIT_MINUTES = 7;
/** Supported web-research deadline. */
export type AiWebSearchTimeLimitMinutes = z.infer<typeof aiWebSearchTimeLimitSchema>;
/** Editable profile; an omitted key preserves the saved secret. */
export const aiProfileSaveSchema = z.object({
	provider: aiProviderSchema,
	apiKey: z.string().max(4096).optional(),
	modelOverride: z.string().trim().max(200).nullable(),
	webSearch: z.boolean(),
	webSearchTimeLimitMinutes: aiWebSearchTimeLimitSchema.optional(),
	baseUrl: z.string().trim().max(2048).optional(),
	protocol: z.enum(['chat-completions', 'anthropic-messages']).optional(),
	chatJsonMode: z.enum(['json_object', 'json_schema', 'prompt_only']).optional(),
	allowInsecureHttp: z.boolean().optional(),
});
/** Save and activate a provider, or disable AI without forgetting profiles. */
export const aiSettingsSaveSchema = z.object({ activeProvider: aiProviderSchema.nullable(), profile: aiProfileSaveSchema.optional() });
/** Settings write request. */
export type AiSettingsSave = z.infer<typeof aiSettingsSaveSchema>;
/** Redacted provider state returned to Settings. */
export const aiProfileStatusSchema = z.object({
	provider: aiProviderSchema, hasKey: z.boolean(), keyPlaceholder: z.string().nullable(),
	modelOverride: z.string().nullable(),
	effectiveModel: z.string(), webSearch: z.boolean(), researchAvailable: z.boolean(),
	webSearchTimeLimitMinutes: aiWebSearchTimeLimitSchema,
	baseUrl: z.string().optional(), protocol: z.enum(['chat-completions', 'anthropic-messages']).optional(),
	chatJsonMode: z.enum(['json_object', 'json_schema', 'prompt_only']).optional(),
});
/** Redacted Settings response. */
export const aiSettingsStatusSchema = z.object({
	activeProvider: aiProviderSchema.nullable(), profiles: z.array(aiProfileStatusSchema),
	connectionWarning: z.string().nullable(),
});
/** AI Settings response. */
export type AiSettingsStatus = z.infer<typeof aiSettingsStatusSchema>;

/** Five result-count targets; generation may return fewer or modestly more matches. */
export const AI_RESULT_COUNTS = [50, 100, 150, 200, 250] as const;
/** Default target balances selection breadth with review effort. */
export const AI_DEFAULT_RESULT_COUNT = 100;
/** Keep modest overages for manual review while bounding unusually broad replies. */
export function aiResultOfferLimit(target: number): number {
	return target + Math.min(25, Math.ceil(target * 0.2));
}
/** Validate the five supported result-count choices. */
export const aiResultCountSchema = z.union([
	z.literal(50), z.literal(100), z.literal(150), z.literal(200), z.literal(250),
]);
/** Supported result-count target for one AI selection request. */
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
	reviewStoppedEarly: z.boolean().optional(),
	finalReviewIncomplete: z.boolean().optional(),
	localDiscoveryFallback: z.boolean().optional(),
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
