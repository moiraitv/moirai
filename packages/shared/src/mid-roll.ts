import { z } from 'zod';
import { fillerSettingsSchema } from './filler-presets.js';
import { DEFAULT_MID_ROLL_PREDICATE, midRollPredicateSchema } from './mid-roll-predicate.js';
export * from './mid-roll-predicate.js';

/** Maximum usable chapter or timed break points retained for one airing. */
export const MAX_MID_ROLL_POINTS = 256;

/** One measured chapter in the logical source timeline, including multipart offsets. */
export interface MediaChapter {
	startSeconds: number;
	finishSeconds: number;
	title: string;
}

/** A primary airing shared by its content spans and inserted filler. */
export const timelineAiringSchema = z.object({
	id: z.uuid(),
	start: z.iso.datetime({ offset: true }),
	finish: z.iso.datetime({ offset: true }),
	primarySegmentId: z.uuid(),
	truncated: z.boolean(),
});
/** Persisted grouping envelope used by guide projection and replacement boundaries. */
export type TimelineAiring = z.infer<typeof timelineAiringSchema>;

/** Reusable break behavior, independent of its filler Program. */
export const midRollSettingsSchema = fillerSettingsSchema.safeExtend({
	fallbackIntervalSeconds: z.number().int().min(1).max(86_400).default(600),
	predicate: midRollPredicateSchema,
}).superRefine((value, context) => {
	if (value.budget.type === 'remaining') {
		context.addIssue({ code: 'custom', path: ['budget'], message: 'Only tail filler can fill the remaining slot' });
	}
});
/** Resolved reusable behavior passed to scheduling workers. */
export type MidRollSettings = z.infer<typeof midRollSettingsSchema>;
/** Validate a named reusable preset. */
export const midRollPresetCreateSchema = midRollSettingsSchema.safeExtend({
	name: z.string().trim().min(1).max(120), description: z.string().trim().max(500).default(''),
});
/** Editable preset fields. */
export type MidRollPresetCreate = z.infer<typeof midRollPresetCreateSchema>;
/** Saved preset metadata and behavior. */
export const midRollPresetSchema = midRollPresetCreateSchema.safeExtend({
	id: z.uuid(), isBuiltin: z.boolean(), createdAt: z.string(), updatedAt: z.string(),
});
/** Named preset presented by the API and editor. */
export type MidRollPreset = z.infer<typeof midRollPresetSchema>;
/** Explicit assignment keeps its source Program separate from reusable behavior. */
export const midRollConfigSchema = z.object({ programId: z.uuid(), presetId: z.uuid() });
/** One authored assignment. */
export type MidRollConfig = z.infer<typeof midRollConfigSchema>;
/** Effective settings used for one source item. */
export type ResolvedMidRollConfig = MidRollSettings & { programId: string };
/** Protected examples available without creating a custom resource. */
export const BUILTIN_MID_ROLL_PRESETS: Array<MidRollPresetCreate & { id: string }> = [
	{ id: 'a39c0000-0000-4000-8000-000000000001', name: 'Two-minute breaks',
		description: 'Up to two minutes of complete filler items between content sections. Oversized items wait for a larger break.', fallbackIntervalSeconds: 600,
		predicate: DEFAULT_MID_ROLL_PREDICATE, budget: { type: 'duration', seconds: 120, policy: 'next-fit-only' } },
	{ id: 'a39c0000-0000-4000-8000-000000000002', name: 'One-item breaks',
		description: 'One full filler item with ten minutes of content between breaks.', fallbackIntervalSeconds: 600,
		predicate: DEFAULT_MID_ROLL_PREDICATE, budget: { type: 'count', count: 1 } },
];
/** Validate an inherited, disabled, or locally configured slot mid-roll rule. */
export const slotMidRollSchema = z.discriminatedUnion('mode', [
	z.object({ mode: z.literal('inherit') }),
	z.object({ mode: z.literal('disabled') }),
	z.object({ mode: z.literal('configured'), config: midRollConfigSchema }),
]);
/** Shared slot override, independent of tail filler. */
export type SlotMidRoll = z.infer<typeof slotMidRollSchema>;

/** Enable an assignment with the standard duration preset. */
export function defaultMidRollConfig(programId: string): MidRollConfig {
	return { programId, presetId: BUILTIN_MID_ROLL_PRESETS[0]!.id };
}
