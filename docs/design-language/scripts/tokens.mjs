import { readFile, writeFile } from 'node:fs/promises';
import { format } from 'prettier';

/** Exact tokens are indexed from their stylesheet so the handbook cannot drift silently. */
const css = await readFile(new URL('../tokens.css', import.meta.url), 'utf8');
/** Stable name and value pairs; CSS comments define the grouping in the source. */
const tokens = [...css.matchAll(/\t(--[\w-]+): ([^;]+);/g)];
/** Generated output is compared in validation and updated only by an explicit command. */
const markdown = await format(`# Token reference\n\n[Handbook](../README.md) · [Foundations](../components/foundations.md) · [Source stylesheet](../tokens.css)\n\nGenerated with \`node docs/design-language/scripts/tokens.mjs\`. Edit the stylesheet, not this\ntable. See foundations and component pages for roles, pairings, composition and state requirements.\nTypography uses rem; pixel equivalents assume a 16px root. Breakpoints are documented in the shared\nbehavior contract because CSS custom properties cannot be used directly in media-query conditions.\n\n| Token | Exact value |\n| --- | --- |\n${tokens.map(([, name, value]) => `| \`${name}\` | \`${value}\` |`).join('\n')}\n`, { parser: 'markdown', printWidth: 100 });

if (process.argv.includes('--check')) {
	if (await readFile(new URL('../docs/tokens.md', import.meta.url), 'utf8') !== markdown) {
		throw new Error('Token reference differs. Run scripts/tokens.mjs.');
	}
}
else {
	await writeFile(new URL('../docs/tokens.md', import.meta.url), markdown);
}
