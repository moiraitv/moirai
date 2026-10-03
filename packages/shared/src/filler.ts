import { z } from 'zod';
import type { SchedulingProgram } from './scheduling.js';

/** Leaf Programs can supply filler without composite quotas or nested selection. */
export function isFillerProgram(program: Pick<SchedulingProgram, 'config'>): boolean {
	return program.config.type !== 'sequence';
}

/** Validate the filler selection policy contract at runtime. */
export const fillerSelectionPolicySchema = z.enum([
	'next-truncate',
	'next-fit-only',
	'best-fit-only',
	'best-fit-or-truncate',
]);
/** Shared wire contract for filler selection policy. */
export type FillerSelectionPolicy = z.infer<typeof fillerSelectionPolicySchema>;

/** Validate the filler config contract at runtime. */
export const fillerConfigSchema = z.object({
	programId: z.uuid(),
	presetId: z.uuid().optional(),
	legacyEmptySlots: z.boolean().optional().describe('Retain pre-preset channel filler in empty slots and its existing cursor.'),
	policy: fillerSelectionPolicySchema.default('best-fit-or-truncate'),
});
/** Shared wire contract for filler config. */
export type FillerConfig = z.infer<typeof fillerConfigSchema>;

/** Validate the slot filler contract at runtime. */
export const slotFillerSchema = z.discriminatedUnion('mode', [
	z.object({ mode: z.literal('inherit') }),
	z.object({ mode: z.literal('disabled') }),
	z.object({ mode: z.literal('configured'), config: fillerConfigSchema }),
]);


/** Normalize legacy fitting aliases while retaining their truncation permission. */
export function canonicalFillerPolicy(policy: FillerSelectionPolicy): 'next-truncate' | 'next-fit-only' {
	return policy === 'best-fit-or-truncate' || policy === 'next-truncate' ? 'next-truncate' : 'next-fit-only';
}
