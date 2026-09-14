import { expect, it } from 'vitest';
import { mediaSearchMatchText } from '@web/media-search-matches';

it('explains all non-title matches without repeating the visible title', () => {
	expect(mediaSearchMatchText()).toBe('');
	expect(mediaSearchMatchText([{ field: 'title', label: 'Example' }])).toBe('');
	expect(mediaSearchMatchText([
		{ field: 'title', label: 'Example' },
		{ field: 'actor', label: 'Example Person' },
		{ field: 'album', label: 'Example Album' },
	])).toBe('Actor · Example Person · Album · Example Album');
});
