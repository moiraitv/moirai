import { describe, expect, it } from 'vitest';
import { suggestedChannelTemplateId } from '@web/channel-template-suggestion';

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
