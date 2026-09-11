import { expect, it } from 'vitest';
import { reviewSidebar } from '@scripts/user-docs-sidebar.js';

it('marks only pending sidebar pages without changing labels or links on the authored input', () => {
	const items = [{ text: 'Guide', items: [
		{ text: 'Programs', link: '/scheduling/programs' },
		{ text: 'Channels', link: '/scheduling/channels' },
		{ text: 'Review status', link: '/review' },
		{ text: 'Welcome', link: '/' },
	] }];
	const marked = reviewSidebar(items, [
		{ path: '/help/scheduling/programs.html', reviewStatus: 'needs-review' },
		{ path: '/help/scheduling/channels.html', reviewStatus: 'reviewed' },
		{ path: '/help/', reviewStatus: 'needs-review' },
	]);
	expect(marked[0]!.items![0]!.text).toContain('docs-menu-review-badge');
	expect(marked[0]!.items![0]!.link).toBe('/scheduling/programs');
	expect(marked[0]!.items![1]).toEqual(items[0]!.items[1]);
	expect(marked[0]!.items![2]).toEqual(items[0]!.items[2]);
	expect(marked[0]!.items![3]!.text).toContain('docs-menu-review-badge');
	expect(items[0]!.items[0]!.text).toBe('Programs');
	expect(reviewSidebar(items, [
		{ path: '/help/scheduling/programs.html', reviewStatus: 'reviewed' },
	])).toEqual(items);
});
