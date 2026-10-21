import { readFile } from 'node:fs/promises';
import { expect, test } from 'vitest';

function tokens(stylesheet: string): Map<string, string> {
	return new Map([...stylesheet.matchAll(/(--[\w-]+): ([^;]+);/g)].map(([, name, value]) => [name!, value!] as const));
}

test('keeps runtime token values and the permanent corner scale aligned with the design reference', async () => {
	const [reference, runtime] = await Promise.all([
		readFile('docs/design-language/tokens.css', 'utf8'),
		readFile('apps/web/src/styles/_tokens.scss', 'utf8'),
	]);
	const actual = tokens(runtime);
	for (const [name, value] of tokens(reference)) {
		expect(actual.get(name), name).toBe(value);
	}
	expect(Object.fromEntries([...actual].filter(([name]) => name.startsWith('--radius-')))).toEqual({
		'--radius-small': '2px', '--radius-control': '4px',
		'--radius-panel': '6px', '--radius-dialog': '8px',
		'--radius-pill': '999px',
	});
});

test('bundles the reference Inter font with its distributable license', async () => {
	const [reference, runtime, license, publicLicense] = await Promise.all([
		readFile('docs/design-language/assets/fonts/InterVariable.woff2'),
		readFile('apps/web/src/assets/fonts/InterVariable.woff2'),
		readFile('apps/web/src/assets/fonts/OFL.txt'),
		readFile('apps/web/public/licenses/Inter-OFL.txt'),
	]);
	expect(runtime.equals(reference)).toBe(true);
	expect(publicLicense.equals(license)).toBe(true);
});
