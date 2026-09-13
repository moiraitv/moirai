import { z } from 'zod';

/** Largest authored credit template accepted by the renderer. */
export const MAX_CREDIT_TEMPLATE_LENGTH = 65_536;
/** Subtitle selection independent of text rendering mode. */
export const subtitlePolicySchema = z.enum(['off', 'forced', 'default', 'any']);
/** Absent properties inherit; null language means any, and null template disables credits. */
export const subtitlePreferencesSchema = z.object({
	language: z.string().trim().toLowerCase().regex(/^[a-z]{2,3}$/).nullable().optional(),
	policy: subtitlePolicySchema.optional(),
	creditsTemplateId: z.uuid().nullable().optional(),
}).strict();
/** Authored subtitle preferences for a channel or program. */
export type SubtitlePreferences = z.infer<typeof subtitlePreferencesSchema>;
/** One reusable Liquid template that emits ASS credits. */
export const creditTemplateCreateSchema = z.object({
	name: z.string().trim().min(1).max(120),
	description: z.string().trim().max(500).default(''),
	source: z.string().min(1).max(MAX_CREDIT_TEMPLATE_LENGTH),
}).strict();
/** Persisted reusable credit template. */
export const creditTemplateSchema = creditTemplateCreateSchema.extend({
	id: z.uuid(),
	isBuiltin: z.boolean().default(false),
	createdAt: z.string(),
	updatedAt: z.string(),
});
/** Persisted reusable credit template. */
export type CreditTemplate = z.infer<typeof creditTemplateSchema>;
/** Complete draft accepted when creating or replacing a template. */
export type CreditTemplateCreate = z.infer<typeof creditTemplateCreateSchema>;
/** Maximum number of catalog videos offered in the credit preview carousel. */
export const CREDIT_PREVIEW_VIDEO_LIMIT = 12;
/** Render using the default encoding profile, or an explicitly supplied legacy channel. */
export const creditPreviewSchema = z.object({
	source: creditTemplateCreateSchema.shape.source,
	mediaItemId: z.uuid(),
	channelId: z.uuid().optional(),
	seconds: z.number().min(0).max(86_400).default(10),
}).strict();
/** Generated ASS and rendered frame returned to the editor. */
export const creditPreviewResultSchema = z.object({
	ass: z.string(),
	image: z.string(),
});
/** Preview draft request. */
export type CreditPreview = z.infer<typeof creditPreviewSchema>;
/** Preview result containing an inline PNG. */
export type CreditPreviewResult = z.infer<typeof creditPreviewResultSchema>;
