import { describe, expect, it } from 'vitest';
import { suggestedChannelAssignment, suggestedChannelTemplateId } from '@web/channel-template-suggestion';

describe('channel template suggestion', () => {
	it('prefers an exact name over a containing phrase and ignores articles, accents, case, and punctuation', () => {
		expect(suggestedChannelTemplateId('The CAFÉ!', [
			{ id: 'daily', name: 'Cafe Daily' },
			{ id: 'exact', name: 'A Cafe' },
		])).toBe('exact');
	});

	it('prefers a full channel-name phrase over a similarly spelled channel', () => {
		expect(suggestedChannelTemplateId('Channel One', [
			{ id: 'other', name: 'Channel Two' },
			{ id: 'daily', name: 'Channel One Daily Template' },
			{ id: 'partial', name: 'Channel Ones' },
		])).toBe('daily');
	});

	it('uses relative spelling distance when names do not match exactly', () => {
		expect(suggestedChannelTemplateId('Moonrise Classics', [
			{ id: 'unrelated', name: 'Evening Cinema Day' },
			{ id: 'similar', name: 'Moonrise Classic' },
			{ id: 'other', name: 'Sports' },
		])).toBe('similar');
	});

	it('keeps the first template when matching scores tie', () => {
		expect(suggestedChannelTemplateId('Cat', [
			{ id: 'first', name: 'Bat' },
			{ id: 'second', name: 'Hat' },
		])).toBe('first');
	});

	it('falls back to the first template for an empty normalized channel name', () => {
		expect(suggestedChannelTemplateId(' ! ', [{ id: 'first', name: 'Daily' }])).toBe('first');
	});

	it('returns no suggestion when no templates exist', () => {
		expect(suggestedChannelTemplateId('Channel', [])).toBeUndefined();
	});
});

describe('channel schedule base suggestion', () => {
	it('keeps a close template ahead of an exact program', () => {
		expect(suggestedChannelAssignment('Moonrise Classics', [
			{ id: 'template', name: 'Moonrise Classic' },
		], [{ id: 'program', name: 'Moonrise Classics' }])).toEqual({
			templateId: 'template', programId: null,
		});
	});

	it('selects a matching program when templates are unrelated', () => {
		expect(suggestedChannelAssignment('Moonrise Classics', [
			{ id: 'template', name: 'Sports Daily' },
		], [
			{ id: 'unrelated', name: 'Evening Cinema' },
			{ id: 'program', name: 'Moonrise Classics Daily' },
		])).toEqual({ templateId: null, programId: 'program' });
	});

	it('keeps the existing template fallback when neither resource name is suitable', () => {
		expect(suggestedChannelAssignment('Moonrise Classics', [
			{ id: 'template', name: 'Sports Daily' },
		], [{ id: 'program', name: 'Evening Cinema' }])).toEqual({
			templateId: 'template', programId: null,
		});
	});

	it('chooses the closest program when no templates exist', () => {
		expect(suggestedChannelAssignment('Moonrise Classics', [], [
			{ id: 'unrelated', name: 'Sports' },
			{ id: 'program', name: 'Moonrise Classic' },
		])).toEqual({ templateId: null, programId: 'program' });
	});
});
