import type { FillerBudget } from '@moirai/shared';
/** Describe the configured amount without implying all filler must be available. */
export function fillerBudgetSummary(budget: FillerBudget): string {
	switch (budget.type) {
		case 'duration': return `${budget.seconds} seconds per break`;
		case 'count': return `${budget.count} item(s) per break`;
		case 'random-count': return `${budget.minimum}–${budget.maximum} items per break`;
		case 'pad': return `Pad to ${budget.minutes}-minute clock boundaries`;
		case 'remaining': return 'Fill remaining slot';
	}
}
