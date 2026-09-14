import type { ScheduleBoundary, StartEligibility } from './scheduling.js';

/** Let newly authored template slots start an item even when it crosses their nominal end. */
export const DEFAULT_TEMPLATE_START_ELIGIBILITY = { type: 'allow-overrun' } as const satisfies StartEligibility;

/** Finish outgoing items without a drift cap when authoring new template boundaries. */
export const DEFAULT_TEMPLATE_BOUNDARY_BEHAVIOR = {
	policy: 'finish-left',
	maxDriftSeconds: null,
	fallback: 'reject-start',
	earlyStartMaxDriftSeconds: 0,
} as const satisfies Pick<ScheduleBoundary, 'policy' | 'maxDriftSeconds' | 'fallback' | 'earlyStartMaxDriftSeconds'>;
