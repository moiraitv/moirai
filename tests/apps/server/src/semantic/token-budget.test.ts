import { expect, it } from 'vitest';
import { budgetSemanticText, SEMANTIC_TOKEN_LIMIT, SEMANTIC_FIELD_BUDGETS } from '@server/semantic/token-budget.js';
import { semanticInput } from '@server/semantic/input.js';

it('reserves description tokens even when every other semantic field is long', () => {
	const words: string[] = [];
	const tokenizer = {
		encode: (text: string) => text.split(/\s+/u).filter(Boolean).map((word) => {
			words.push(word);
			return words.length - 1;
		}),
		decode: (ids: number[]) => ids.map((id) => words[id]).join(' '),
	};
	const input = semanticInput(
		{ title: 'title '.repeat(500), kind: 'episode', plot: 'episode-story '.repeat(1000), metadata: { genres: ['genre '.repeat(1000)] } },
		[{ title: 'show '.repeat(500), kind: 'show', plot: 'ancestor-context '.repeat(1000), metadata: {} }],
	);
	const result = budgetSemanticText(input, tokenizer);
	expect(tokenizer.encode(result).length).toBeLessThanOrEqual(SEMANTIC_TOKEN_LIMIT);
	expect(result.split(' ').filter((word) => word === 'episode-story').length).toBe(SEMANTIC_FIELD_BUDGETS.overview - 1);
	expect(result).toContain('show:');
	expect(budgetSemanticText(input, tokenizer)).toBe(result);
});
