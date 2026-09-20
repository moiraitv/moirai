import type { PreTrainedTokenizer } from '@huggingface/transformers';

/** BGE's 512-token window reserves two positions for its special tokens. */
export const SEMANTIC_TOKEN_LIMIT = 510;
/** Reserved token budgets protect item descriptions from long ancestor metadata. */
export const SEMANTIC_FIELD_BUDGETS = { identity: 64, overview: 256, metadata: 96, context: 94 } as const;

/** Keep the item's description and bounded ancestor context within the actual model token limit. */
export function budgetSemanticText(text: string, tokenizer: Pick<PreTrainedTokenizer, 'encode' | 'decode'>): string {
	const sections: Record<keyof typeof SEMANTIC_FIELD_BUDGETS, string[]> = { identity: [], overview: [], metadata: [], context: [] };
	let context = false;
	for (const line of text.split('\n')) {
		const label = line.slice(0, line.indexOf(':'));
		if (['show', 'artist', 'album', 'Context'].includes(label)) {
			context = true;
		}
		const section = label === 'Overview' ? 'overview' : ['Title', 'Type'].includes(label) ? 'identity' : context ? 'context' : 'metadata';
		sections[section].push(line);
	}
	const ids = (Object.keys(SEMANTIC_FIELD_BUDGETS) as Array<keyof typeof SEMANTIC_FIELD_BUDGETS>).flatMap((section) =>
		tokenizer.encode(sections[section].join('\n'), { add_special_tokens: false }).slice(0, SEMANTIC_FIELD_BUDGETS[section]));
	return tokenizer.decode(ids, { skip_special_tokens: true });
}
