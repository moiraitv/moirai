import { z } from 'zod';
import { aiContentSelectionRequestSchema, aiContentSelectionResponseSchema } from './ai-selection.js';
import { aiProgressSchema } from './ai-progress.js';

/** Target duration used for generation budgets and elapsed-time progress estimates. */
export const AI_GENERATION_TARGET_MS = 180_000;

/** Client-chosen identity makes reconnects safe without starting a second paid generation. */
export const aiGenerationRequestSchema = aiContentSelectionRequestSchema.extend({ id: z.uuid() });
/** Request for one reconnectable generation. */
export type AiGenerationRequest = z.infer<typeof aiGenerationRequestSchema>;
/** Retained generation state; only complete, validated selections become results. */
export const aiGenerationSchema = z.object({
	id: z.uuid(),
	startedAt: z.number(),
	state: z.enum(['running', 'completed', 'failed']),
	status: aiProgressSchema,
	batch: z.number().int().positive().optional(),
	totalBatches: z.number().int().positive().optional(),
	result: aiContentSelectionResponseSchema.optional(),
	message: z.string().optional(),
});
/** Public snapshot of a server-owned generation. */
export type AiGeneration = z.infer<typeof aiGenerationSchema>;
