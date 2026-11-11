import { z } from 'zod';
import { audioPreferencesSchema } from './audio.js';
import { graphicsAssignmentSchema } from './graphics.js';
import { subtitlePreferencesSchema } from './subtitles.js';

/** Maximum authored steps in a Sequence and entries in its rotation arrays. */
export const MAX_SEQUENCE_STEPS = 100;

/** Maximum selections allocated to one step in counted ordering modes. */
export const MAX_SEQUENCE_STEP_COUNT = 10_000;

/** Validate the sequence entry contract at runtime. */
export const sequenceEntrySchema = z.object({
	id: z.uuid(),
	programId: z.uuid(),
	count: z.number().int().min(0).max(MAX_SEQUENCE_STEP_COUNT)
		.describe('Whole percentage from 0 to 100 in Chance mode, or item count from 1 to 10000 in other modes'),
});
/** Shared wire contract for sequence entry. */
export type SequenceEntry = z.infer<typeof sequenceEntrySchema>;

/** Ordering and allocation of sequence steps, independent of child media selection. */
export const sequenceOrderingSchema = z.discriminatedUnion('type', [
	z.object({ type: z.literal('ordered') }),
	z.object({ type: z.literal('shuffled-blocks'), seed: z.string().trim().max(200).default('') }),
	z.object({ type: z.literal('shuffled-allocations'), seed: z.string().trim().max(200).default('') }),
	z.object({ type: z.literal('balanced-rotation') }),
	z.object({ type: z.literal('chance'), seed: z.string().trim().max(200).default('') }),
]);
/** Authored ordering rules; omitted configuration retains legacy ordered playback. */
export type SequenceOrdering = z.infer<typeof sequenceOrderingSchema>;

/** Child Programs and their parent ordering and presentation preferences. */
const sequenceProgramConfigShape = z.object({
	type: z.literal('sequence'),
	graphicsAssignment: graphicsAssignmentSchema.optional(),
	subtitlePreferences: subtitlePreferencesSchema.optional(),
	audioPreferences: audioPreferencesSchema.optional(),
	entries: z
		.array(sequenceEntrySchema)
		.min(1)
		.max(MAX_SEQUENCE_STEPS)
		.refine((entries) => new Set(entries.map((entry) => entry.id)).size === entries.length, {
			message: 'Sequence entry identifiers must be unique',
		}),
	repeat: z.boolean().default(true),
	ordering: sequenceOrderingSchema.optional(),
});

/** List the authored steps that can contribute media during scheduling. */
export function eligibleSequenceEntries(config: Pick<z.infer<typeof sequenceProgramConfigShape>, 'entries' | 'ordering'>): SequenceEntry[] {
	return config.ordering?.type === 'chance' ? config.entries.filter(entry => entry.count > 0) : config.entries;
}

/** Apply mode-specific quantity limits to saved Programs and scheduling previews. */
function validateSequenceQuantities(config: z.infer<typeof sequenceProgramConfigShape>, context: z.RefinementCtx): void {
	const chance = config.ordering?.type === 'chance';
	config.entries.forEach((entry, index) => {
		if (chance ? entry.count > 100 : entry.count < 1) {
			context.addIssue({ code: 'custom', path: ['entries', index, 'count'],
				message: chance ? 'Chance must be a whole percentage from 0 to 100' : 'Count must be at least 1' });
		}
	});
}

/** A Sequence with quantity interpreted according to its ordering mode. */
export const sequenceProgramConfigSchema = sequenceProgramConfigShape.superRefine(validateSequenceQuantities);

/** Scheduling-only inputs for a fresh sample day, independent of channel progress. */
export const sequencePreviewSchema = z.object({
	id: z.uuid(),
	config: sequenceProgramConfigShape.omit({ audioPreferences: true, subtitlePreferences: true }).superRefine(validateSequenceQuantities),
	startDate: z.iso.date().optional(),
});
/** Validated request for a Sequence's illustrative guide preview. */
export type SequencePreview = z.infer<typeof sequencePreviewSchema>;
