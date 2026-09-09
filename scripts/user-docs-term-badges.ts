import Token from 'markdown-it/lib/token.mjs';

/** Shared core-hook contract used by standalone MarkdownIt and VitePress's bundled renderer. */
interface BadgeMarkdown {
	core: {
		ruler: {
			after: (afterName: string, ruleName: string, rule: (state: { tokens: Token[] }) => void) => void;
		};
	};
}

/** Known guide icons and the resource names that may share their inline badge. */
const terms = new Map([
	['library', /^\s*(Librar(?:y|ies))\b/],
	['list-video', /^\s*(Programs?)\b/],
	['calendar-days', /^\s*(Guide)\b/],
	['calendar-range', /^\s*(Templates?)\b/],
	['tv-minimal-play', /^\s*(Channel\s+[Ss]chedules?)\b/],
	['tv-minimal', /^\s*(Channels?)\b/],
]);

/** Make plain text without interpreting the label as authored HTML. */
function textToken(content: string): Token {
	const token = new Token('text', '', 0);
	token.content = content;
	return token;
}

/** Group resource icons and labels without enabling authored HTML or changing heading anchors. */
export function userDocsTermBadges(markdown: BadgeMarkdown): void {
	markdown.core.ruler.after('inline', 'user-docs-term-badges', (state) => {
		for (const [blockIndex, block] of state.tokens.entries()) {
			if (block.type !== 'inline' || !block.children
				|| state.tokens[blockIndex - 1]?.type === 'heading_open') {
				continue;
			}

			const children = block.children;
			for (let index = 0; index < children.length; index += 1) {
				const icon = children[index]!;
				const name = icon.type === 'image'
					? icon.attrGet('src')?.match(/^\/(?:help\/)?icons\/([^/]+)\.svg$/)?.[1]
					: undefined;
				const pattern = name ? terms.get(name) : undefined;
				if (!pattern) {
					continue;
				}

				// Move a linked label's icon inside the link so the badge remains one click target.
				const linked = children[index + 1]?.type === 'text'
					&& !children[index + 1]!.content.trim()
					&& children[index + 2]?.type === 'link_open';
				const labelIndex = index + (linked ? 3 : 1);
				const label = children[labelIndex];
				const match = label?.type === 'text' ? label.content.match(pattern) : null;
				if (!match) {
					// General lowercase mentions should not retain a standalone decorative icon either.
					if (label?.type === 'text' && new RegExp(pattern.source, 'i').test(label.content)) {
						children.splice(index, 1);
						index -= 1;
					}
					continue;
				}

				const open = new Token('span_open', 'span', 1);
				open.attrSet('class', 'docs-term-badge');
				open.attrSet('data-tone', name!.startsWith('tv-') ? 'blue' : 'green');
				const replacement = [open, icon, textToken(match[1]!), new Token('span_close', 'span', -1)];
				if (linked) {
					replacement.unshift(children[index + 2]!);
				}
				const remainder = label!.content.slice(match[0].length);
				if (remainder) {
					replacement.push(textToken(remainder));
				}
				children.splice(index, labelIndex - index + 1, ...replacement);
				index += replacement.length - 1;
			}
		}
	});
}
