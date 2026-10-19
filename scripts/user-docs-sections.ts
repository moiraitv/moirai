import MarkdownIt from 'markdown-it';

/** One explicitly anchored card section, including its subordinate headings and content. */
export interface ContextualSection {
	anchor: string;
	title: string;
	body: string;
}

/** Extract authored second-level sections without treating fenced code as guide headings. */
export function contextualSections(body: string): ContextualSection[] {
	const tokens = new MarkdownIt({ html: false }).parse(body, {});
	const lines = body.split('\n');
	const headings = tokens.flatMap((token, index) => token.type === 'heading_open'
		&& token.tag === 'h2' && token.level === 0 && token.map
		? [{ title: tokens[index + 1]!.content, start: token.map[0], end: token.map[1] }] : []);
	const sections: ContextualSection[] = [];
	const anchors = new Set<string>();
	for (const [index, heading] of headings.entries()) {
		const match = /^(.*?)\s+\{#([a-z][a-z0-9-]*)\}$/u.exec(heading.title);
		if (!match) {
			continue;
		}
		const anchor = match[2]!;
		if (anchors.has(anchor)) {
			throw new Error(`Duplicate contextual section anchor: ${anchor}`);
		}
		anchors.add(anchor);
		sections.push({ anchor, title: match[1]!, body: lines.slice(heading.end, headings[index + 1]?.start).join('\n') });
	}
	return sections;
}

/** Keep VitePress's explicit anchor annotations out of the restricted contextual renderer. */
export function withoutHeadingAnchors(body: string): string {
	const lines = body.split('\n');
	for (const token of new MarkdownIt({ html: false }).parse(body, {})) {
		if (token.type === 'heading_open' && token.map) {
			const line = token.map[0];
			lines[line] = lines[line]!.replace(/\s+\{#[a-z][a-z0-9-]*\}$/u, '');
		}
	}
	return lines.join('\n');
}
