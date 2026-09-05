import { describe, expect, it } from 'vitest';
import { catalogProgramItemFilterSchema } from '@moirai/shared';
import {
	QUICK_SCENARIOS,
	quickSelectionStrategy,
	quickSourceSummary,
	suggestedQuickTemplateName,
	suggestedQuickChannelNumber,
} from '@web/quick-setup';

describe('quick setup helpers', () => {
	it('provides tailored scenario strategy defaults', () => {
		expect(QUICK_SCENARIOS.map((preset) => [preset.id, preset.strategy])).toEqual([
			['movies', 'shuffle'],
			['shows', 'sequential'],
			['music-videos', 'shuffle'],
		]);
	});

	it('suggests the first unused positive integer channel number', () => {
		expect(suggestedQuickChannelNumber(['1', '2', '4', '98.7', 'News'])).toBe('3');
		expect(suggestedQuickTemplateName('Movie Channel', [
			'movie channel daily',
			'Movie Channel Daily (2)',
		])).toBe('Movie Channel Daily (3)');
	});

	it('preserves deterministic seeds and summarizes sources', () => {
		expect(quickSelectionStrategy('shuffle', 'nightly')).toEqual({
			type: 'shuffle',
			seed: 'nightly',
		});
		expect(quickSourceSummary({
			type: 'library-query',
			...catalogProgramItemFilterSchema.parse({ genres: ['comedy'] }),
			sort: { type: 'name', direction: 'asc' },
			itemLimit: null,
		})).toBe('Library query · 1 active filter · Title / episode, ascending · All matches');
		expect(quickSourceSummary({
			type: 'collection',
			itemIds: ['00000000-0000-4000-8000-000000000001'],
		})).toBe('1 selected item');
	});
});
