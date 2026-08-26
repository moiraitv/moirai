import { z } from 'zod';

/** Validate source health reported by library discovery. */
export const sourceAvailabilitySchema = z.enum(['unknown', 'available', 'degraded', 'unavailable']);
/** Validate whether indexed media was confirmed by the latest healthy scan. */
export const mediaAvailabilitySchema = z.enum(['available', 'unconfirmed']);
/** Validate operator reconciliation state for removals and source changes. */
export const reconciliationStatusSchema = z.enum([
	'idle',
	'observing-removals',
	'removal-approval-required',
	'source-approval-required',
	'source-accepting',
]);

/** Source health reported by library discovery. */
export type SourceAvailability = z.infer<typeof sourceAvailabilitySchema>;
/** Whether indexed media was confirmed by the latest healthy scan. */
export type MediaAvailability = z.infer<typeof mediaAvailabilitySchema>;
/** Operator reconciliation state for removals and source changes. */
export type ReconciliationStatus = z.infer<typeof reconciliationStatusSchema>;
