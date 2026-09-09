/** Categories whose current contents still need human approval. */
export type HelpReviewReason = 'initial' | 'text' | 'screenshots' | 'icons' | 'unknown';

/** Describe review scope consistently in the CLI, guide, and contextual drawer. */
export function helpReviewLabel(reasons?: readonly HelpReviewReason[]): string {
	if (!reasons?.length) {
		return 'Needs review';
	}
	if (reasons.includes('initial')) {
		return 'Initial review required';
	}
	if (reasons.includes('unknown')) {
		return 'Unknown changes—full review required';
	}
	const visual = reasons.includes('screenshots') && reasons.includes('icons')
		? 'visual assets'
		: reasons.includes('screenshots') ? 'screenshots' : reasons.includes('icons') ? 'icons' : '';
	const label = reasons.includes('text') ? `text${visual ? ` and ${visual}` : ''}` : visual;
	return `${label.charAt(0).toUpperCase()}${label.slice(1)} changed`;
}
