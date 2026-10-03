import { z } from 'zod';
import { fillerSelectionPolicySchema, type FillerSelectionPolicy } from './filler.js';

/** Supported independently assigned filler stages. */
export const fillerKindSchema = z.enum(['pre-roll', 'mid-roll', 'post-roll', 'tail']);
/** A reusable preset's immutable playback stage. */
export type FillerKind = z.infer<typeof fillerKindSchema>;
/** Clock intervals whose boundaries repeat evenly within each local hour. */
export const FILLER_PAD_MINUTES = [1, 5, 10, 15, 20, 30, 60] as const;
/** Bounded filler budgets shared by all stages; remaining-slot is tail-only. */
export const fillerBudgetSchema = z.discriminatedUnion('type', [
	z.object({ type: z.literal('duration'), seconds: z.number().int().min(1).max(86_400), policy: fillerSelectionPolicySchema.default('best-fit-or-truncate') }),
	z.object({ type: z.literal('pad'), minutes: z.union(FILLER_PAD_MINUTES.map(value => z.literal(value))), policy: fillerSelectionPolicySchema.default('best-fit-or-truncate') }),
	z.object({ type: z.literal('count'), count: z.number().int().min(1).max(100) }),
	z.object({ type: z.literal('random-count'), minimum: z.number().int().min(0).max(100), maximum: z.number().int().min(0).max(100) }),
	z.object({ type: z.literal('remaining'), policy: fillerSelectionPolicySchema.default('best-fit-or-truncate') }),
]);
/** Validated filler amount and fitting behavior. */
export type FillerBudget = z.infer<typeof fillerBudgetSchema>;
/** Settings for stages without mid-roll chapter predicates. */
export const fillerSettingsSchema = z.object({ budget: fillerBudgetSchema }).superRefine((value, context) => {
	if (value.budget.type === 'random-count' && value.budget.minimum > value.budget.maximum) {
		context.addIssue({ code: 'custom', path: ['budget', 'maximum'], message: 'Maximum quantity must be at least the minimum' });
	}
});
/** Resolved behavior for a filler stage. */
export type FillerSettings = z.infer<typeof fillerSettingsSchema>;
/** Named settings for pre/post-roll and tail, with kind-specific budget validation. */
export const fillerPresetCreateSchema = fillerSettingsSchema.safeExtend({
	kind: fillerKindSchema.exclude(['mid-roll']), name: z.string().trim().min(1).max(120), description: z.string().trim().max(500).default(''),
}).superRefine((value, context) => {
	if (value.kind !== 'tail' && value.budget.type === 'remaining') {
		context.addIssue({ code: 'custom', path: ['budget'], message: 'Only tail filler can fill the remaining slot' });
	}
});
/** Editable non-mid-roll preset. */
export type FillerPresetCreate = z.infer<typeof fillerPresetCreateSchema>;
/** Stored non-mid-roll preset metadata. */
export const fillerPresetSchema = fillerPresetCreateSchema.safeExtend({ id: z.uuid(), isBuiltin: z.boolean(), createdAt: z.string(), updatedAt: z.string() });
/** Persisted non-mid-roll preset. */
export type FillerPreset = z.infer<typeof fillerPresetSchema>;
/** Preset and independently authored filler source. */
export const fillerAssignmentSchema = z.object({ programId: z.uuid(), presetId: z.uuid() });
/** Authored stage assignment. */
export type FillerAssignment = z.infer<typeof fillerAssignmentSchema>;
/** Inheritance and explicit stage overrides. */
export const slotFillerAssignmentSchema = z.discriminatedUnion('mode', [
	z.object({ mode: z.literal('inherit') }), z.object({ mode: z.literal('disabled') }),
	z.object({ mode: z.literal('configured'), config: fillerAssignmentSchema }),
]);
/** Slot-local stage configuration. */
export type SlotFillerAssignment = z.infer<typeof slotFillerAssignmentSchema>;
/** Stable remaining-slot preset ID corresponding to the legacy tail policy. */
export function legacyTailPresetId(policy: FillerSelectionPolicy): string {
	return `a40c0000-0000-4000-8000-00000000000${['best-fit-or-truncate', 'best-fit-only', 'next-truncate', 'next-fit-only'].indexOf(policy) + 3}`;
}
/** Protected examples and legacy tail fitting behaviors. */
export const BUILTIN_FILLER_PRESETS: Array<FillerPresetCreate & { id: string }> = [
	{ id: 'a40c0000-0000-4000-8000-000000000001', kind: 'pre-roll', name: 'One-item introduction', description: 'One complete filler item before each primary item.', budget: { type: 'count', count: 1 } },
	{ id: 'a40c0000-0000-4000-8000-000000000002', kind: 'post-roll', name: 'One-item closing', description: 'One complete filler item after each primary item.', budget: { type: 'count', count: 1 } },
	...fillerSelectionPolicySchema.options.map(policy => ({ id: legacyTailPresetId(policy), kind: 'tail' as const, name: `Remaining slot: ${policy}`, description: 'Fill the remaining slot using the selected fitting policy.', budget: { type: 'remaining' as const, policy } })),
];
/** Enable the maintained default preset for a non-mid-roll stage. */
export function defaultFillerAssignment(kind: Exclude<FillerKind, 'mid-roll'>, programId: string): FillerAssignment {
	return { programId, presetId: BUILTIN_FILLER_PRESETS.find(preset => preset.kind === kind)!.id };
}
