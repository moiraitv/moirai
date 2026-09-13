import type Token from 'markdown-it/lib/token.mjs';

/** Shared hook surface across the guide's and Help manifest's MarkdownIt versions. */
interface IntroductionMarkdown {
	core: {
		ruler: {
			after: (afterName: string, ruleName: string, rule: (state: { tokens: Token[] }) => void) => void;
		};
	};
}

/** Style authored introduction callouts identically in the guide and restricted Help renderer. */
export function userDocsIntroductions(markdown: IntroductionMarkdown): void {
	markdown.core.ruler.after('inline', 'user-docs-introductions', (state) => {
		for (let index = 0; index < state.tokens.length; index++) {
			const token = state.tokens[index]!;
			if (token.type !== 'blockquote_open'
				|| state.tokens[index + 1]?.type !== 'paragraph_open'
				|| state.tokens[index + 2]?.content !== '[!INTRODUCTION]'
				|| state.tokens[index + 3]?.type !== 'paragraph_close') {
				continue;
			}
			token.attrJoin('class', 'docs-introduction');
			state.tokens.splice(index + 1, 3);
		}
	});
}
