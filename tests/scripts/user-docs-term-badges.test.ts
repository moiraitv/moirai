import MarkdownIt from 'markdown-it';
import { describe, expect, it } from 'vitest';
import { userDocsTermBadges } from '@scripts/user-docs-term-badges.js';

describe('user documentation term badges', () => {
	const markdown = new MarkdownIt({ html: false }).use(userDocsTermBadges);
	const icon = '![](/icons/library.svg)';

	it('groups a bold label and icon without absorbing the rest of the sentence', () => {
		const html = markdown.render(`A **${icon} Library** holds media.`);
		expect(html).toContain('docs-term-badge');
		expect(html).toContain(' holds media.');
	});

	it('keeps linked labels clickable and preserves their destination', () => {
		const html = markdown.render(`${icon} [Libraries and scanning](/libraries/managing-libraries)`);
		expect(html).toContain('href="/libraries/managing-libraries"');
		expect(html).toContain('docs-term-badge');
	});

	it('uses the blue schedule badge for the complete compound term', () => {
		const html = markdown.render('![](/icons/tv-minimal-play.svg) Channel Schedules apply.');
		expect(html).toContain('data-tone="blue"');
		expect(html).toContain('Channel Schedules</span> apply.');
	});

	it('uses the media-list icon for Program badges', () => {
		const html = markdown.render('![](/icons/list-video.svg) Program');
		expect(html).toContain('docs-term-badge');
		expect(html).toContain('data-tone="green"');
		expect(html).toContain('src="/icons/list-video.svg"');
	});

	it('badges the Guide page but leaves generic guide references plain', () => {
		const guideIcon = '![](/icons/calendar-days.svg)';
		expect(markdown.render(`${guideIcon} Guide`)).toContain('docs-term-badge');
		const generic = markdown.render(`${guideIcon} guide`);
		expect(generic).not.toContain('docs-term-badge');
		expect(generic).not.toContain('<img');
	});

	it('leaves headings, code, screenshots, and mismatched labels unchanged', () => {
		for (const source of [`# ${icon} Library`, `\`${icon} library\``,
			'![Library](/screenshots/libraries.png)', `${icon} unrelated`]) {
			expect(markdown.render(source)).not.toContain('docs-term-badge');
		}
	});

	it('continues escaping authored HTML', () => {
		expect(markdown.render(`${icon} library <script>alert(1)</script>`)).toContain('&lt;script&gt;');
	});

	it('leaves general lowercase uses plain even when an icon was authored', () => {
		for (const label of ['library', 'libraries', '[library](/libraries/managing-libraries)']) {
			const html = markdown.render(`${icon} ${label}`);
			expect(html).not.toContain('docs-term-badge');
			expect(html).not.toContain('<img');
			expect(html).toContain(label.startsWith('[') ? '<a href=' : label);
		}
	});
});
