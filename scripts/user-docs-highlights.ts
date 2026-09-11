import matter from 'gray-matter';
import type MarkdownIt from 'markdown-it';
import type Token from 'markdown-it/lib/token.mjs';
import type { ReviewChange } from './user-docs-review.js';

/** Current Markdown locations that differ from a verified approval. */
export interface ReviewHighlights {
	lines: number[];
	images: string[];
	all: boolean;
}

/** Shared renderer and core hook supported by standalone MarkdownIt and VitePress. */
interface HighlightMarkdown {
	core: {
		ruler: {
			after: (after: string, name: string, rule: (state: { tokens: Token[]; env: { frontmatter?: { id?: string } } }) => void) => void;
		};
	};
	renderer: MarkdownIt['renderer'];
}

/** Translate unified diff positions into zero-based Markdown body lines. */
export function reviewHighlights(source: string, change: ReviewChange): ReviewHighlights {
	const normalized = source.replace(/\r\n?/gu, '\n');
	const body = matter(normalized).content;
	const offset = normalized.slice(0, normalized.length - body.length).split('\n').length - 1;
	const lines = new Set<number>();
	let current = 0;
	for (const line of change.textDiff) {
		const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/u.exec(line);
		if (hunk) {
			current = Number(hunk[1]) - 1;
		}
		else if (line.startsWith('+')) {
			if (current >= offset && line.slice(1).trim()) {
				lines.add(current - offset);
			}
			current += 1;
		}
		else if (line.startsWith(' ')) {
			current += 1;
		}
	}
	return {
		lines: [...lines],
		images: change.images.filter((image) => image.after).map((image) => `/${image.name}`),
		all: change.baseline === 'initial',
	};
}

/** Outline the smallest visible Markdown blocks containing pending text or image changes. */
export function userDocsHighlights(markdown: HighlightMarkdown, pages: Array<{ id: string; reviewHighlights?: ReviewHighlights }>): void {
	const highlights = new Map(pages.map((page) => [page.id, page.reviewHighlights]));
	markdown.core.ruler.after('inline', 'user-docs-highlights', (state) => {
		const changes = highlights.get(state.env.frontmatter?.id ?? '');
		if (!changes) {
			return;
		}
		const blocks = state.tokens.filter((token) => token.map && !token.hidden && (token.nesting === 1 || ['fence', 'code_block'].includes(token.type)));
		/** Mark the innermost rendered block without outlining its containing list too. */
		const mark = (line: number): void => {
			const candidates = blocks.filter((token) => token.map![0] <= line && token.map![1] > line);
			candidates.sort((a, b) => b.level - a.level);
			candidates[0]?.attrJoin('class', 'docs-review-changed');
		};
		for (const line of changes.lines) {
			mark(line);
		}
		for (const token of state.tokens) {
			if (token.map && (changes.all || token.children?.some((child) => child.type === 'image' && changes.images.includes(child.attrGet('src') ?? '')))) {
				mark(token.map[0]);
			}
		}
	});
	for (const type of ['fence', 'code_block']) {
		const render = markdown.renderer.rules[type]!;
		markdown.renderer.rules[type] = (tokens, index, options, env, renderer) => {
			const html = render(tokens, index, options, env, renderer);
			return tokens[index]!.attrGet('class')?.includes('docs-review-changed') ? `<div class="docs-review-changed">${html}</div>` : html;
		};
	}
}
