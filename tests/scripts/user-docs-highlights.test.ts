import MarkdownIt from 'markdown-it';
import matter from 'gray-matter';
import { expect, it } from 'vitest';
import { reviewHighlights, userDocsHighlights } from '@scripts/user-docs-highlights.js';
import type { ReviewChange } from '@scripts/user-docs-review.js';

const source = '---\nid: topic\n---\n# Title\n\nUnchanged.\n\nNew text.\n\n![Shot](/screenshots/example.png)\n\n- Same item\n- New item\n\n```js\nchanged()\n```\n';
const change: ReviewChange = {
	id: 'topic', title: 'Topic', href: '/help/topic.html', baseline: 'approved',
	textDiff: ['@@ -6,1 +6,3 @@', ' Unchanged.', '+', '+New text.', '@@ -11,1 +13,1 @@', '- Old item', '+- New item', '@@ -14,1 +16,1 @@', '-old()', '+changed()'],
	images: [{ name: 'screenshots/example.png', before: '/old.png', after: '/new.png', aspectRatio: 1 }],
};

it('outlines changed paragraphs, list items, images, and code without outlining unchanged content', () => {
	const highlights = reviewHighlights(source, change);
	expect(highlights.lines).toEqual([4, 9, 12]);
	const md = new MarkdownIt().use(userDocsHighlights, [{ id: 'topic', reviewHighlights: highlights }]);
	const html = md.render(matter(source).content, { frontmatter: { id: 'topic' } });
	expect(html).toContain('<p>Unchanged.</p>');
	expect(html).toContain('<h1>Title</h1>');
	expect(html).toContain('<p class="docs-review-changed">New text.</p>');
	expect(html).toContain('<p class="docs-review-changed"><img');
	expect(html).toContain('<li>Same item</li>');
	expect(html).toContain('<li class="docs-review-changed">New item</li>');
	expect(html).toContain('<div class="docs-review-changed"><pre>');
	expect(md.render(matter(source).content, { frontmatter: { id: 'reviewed' } })).not.toContain('docs-review-changed');
});

it('marks initial pages but does not guess text changes when the approved source is unavailable', () => {
	for (const baseline of ['initial', 'unavailable'] as const) {
		const highlights = reviewHighlights(source, { ...change, baseline, textDiff: [], images: [] });
		const md = new MarkdownIt().use(userDocsHighlights, [{ id: 'topic', reviewHighlights: highlights }]);
		const html = md.render(matter(source).content, { frontmatter: { id: 'topic' } });
		expect(html.includes('docs-review-changed')).toBe(baseline === 'initial');
	}
});
