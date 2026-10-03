import { z } from 'zod';
import { fillerPresetCreateSchema, fillerPresetSchema } from './filler-presets.js';
import { midRollPresetCreateSchema, midRollPresetSchema } from './mid-roll.js';
/** Administration contract for any immutable filler stage. */
export const anyFillerPresetCreateSchema = z.union([fillerPresetCreateSchema, midRollPresetCreateSchema.safeExtend({ kind: z.literal('mid-roll') })]);
/** Editable stage-specific preset. */
export type AnyFillerPresetCreate = z.infer<typeof anyFillerPresetCreateSchema>;
/** Stored preset including its immutable stage and metadata. */
export const anyFillerPresetSchema = z.union([fillerPresetSchema, midRollPresetSchema.safeExtend({ kind: z.literal('mid-roll') })]);
/** Saved stage-specific preset. */
export type AnyFillerPreset = z.infer<typeof anyFillerPresetSchema>;
