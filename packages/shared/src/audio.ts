import { z } from 'zod';

/** Absent fields inherit; null explicitly removes an inherited audio preference. */
export const audioPreferencesSchema = z.object({
	language: z.string().trim().toLowerCase().regex(/^[a-z]{2,3}$/).nullable().optional(),
	title: z.string().trim().min(1).max(200).nullable().optional(),
}).strict();

/** Optional language and track-title preferences, independent of audio encoding. */
export type AudioPreferences = z.infer<typeof audioPreferencesSchema>;
