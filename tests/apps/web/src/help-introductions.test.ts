import MarkdownIt from 'markdown-it';
import { describe, expect, it } from 'vitest';
import { userDocsIntroductions } from '../../../../scripts/user-docs-introductions';

describe('guide introductions', () => {
	it('styles the authored callout while retaining headings, icons, and cards', () => {
		const markdown = new MarkdownIt({ html: false }).use(userDocsIntroductions);
		const html = markdown.render('> [!INTRODUCTION]\n>\n> ## What is a program?\n>\n> - ![](/icons/introduction-shuffle.svg)\n>\n>   **Shuffle Movies**\n>\n>   Play without repeats.');
		expect(html).toContain('<blockquote class="docs-introduction">');
		expect(html).toContain('<h2>What is a program?</h2>');
		expect(html).toContain('src="/icons/introduction-shuffle.svg"');
		expect(html).toContain('<strong>Shuffle Movies</strong>');
		expect(html).not.toContain('[!INTRODUCTION]');
	});

	it('leaves ordinary quotes and literal HTML restricted', () => {
		const markdown = new MarkdownIt({ html: false }).use(userDocsIntroductions);
		const html = markdown.render('> Ordinary quote\n\n<script>alert(1)</script>');
		expect(html).not.toContain('docs-introduction');
		expect(html).not.toContain('<script>');
		expect(html).toContain('&lt;script&gt;');
	});
});
