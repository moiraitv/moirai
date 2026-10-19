import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import path from 'node:path';

/** Copy the current bundled contextual guide without publishing or changing review status. */
const root = path.resolve('docs/design-language');
/** Existing application documentation build is read-only input to the local reference snapshot. */
const source = path.resolve('apps/docs/dist');
/** Preserve topic IDs, full-page destinations, review warnings and actual rendered guidance. */
const manifest = JSON.parse(await readFile(path.join(source, 'contextual-help.json'), 'utf8'));
/** Map bundled application guide paths to self-contained local chapter snapshots. */
const pages = new Map(manifest.pages.map(page => [page.path, page.id]));
/** Files copied once even when several contextual sections share the same artwork. */
const copied = new Set();
await mkdir(path.join(root, 'assets/help'), { recursive: true });
for (const topic of Object.values(manifest.topics)) {
	let html = topic.html;
	for (const [, relative] of html.matchAll(/src="\/help\/([^"?#]+)"/g)) {
		const file = path.join('assets/help/files', relative);
		if (!copied.has(relative)) {
			await mkdir(path.dirname(path.join(root, file)), { recursive: true });
			await copyFile(path.join(source, relative), path.join(root, file));
			copied.add(relative);
		}
		html = html.replaceAll(`/help/${relative}`, `./${file}`);
	}
	html = html.replace(/href="(\/help\/[^"#]*)(#[^"]*)?"/g, (match, href, hash = '') => {
		const id = pages.get(href);
		return id ? `href="./assets/help/${id}.html${hash}"` : match;
	});
	topic.html = html;
	const full = topic.fullPath.split('#');
	topic.localPath = `./assets/help/${pages.get(full[0]) ?? topic.id.split('#')[0]}.html${full[1] ? `#${full[1]}` : ''}`;
	if (!topic.id.includes('#')) {
		await writeFile(path.join(root, `assets/help/${topic.id}.html`), `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><base href="../../"><link rel="stylesheet" href="./tokens.css"><link rel="stylesheet" href="./gallery/base.css"><link rel="stylesheet" href="./gallery/help.css"><title>${topic.title} · Local guide snapshot</title></head><body><main class="local-help-page"><a href="./README.md">Design reference</a><p class="small muted">Local snapshot of the bundled application guide. Review state is preserved.</p><h1>${topic.title}</h1>${html}</main></body></html>`);
	}
}
await writeFile(path.join(root, 'assets/help/manifest.json'), `${JSON.stringify({ guideVersion: manifest.guideVersion, topics: manifest.topics }, null, 2)}\n`);
console.log(`Copied ${Object.keys(manifest.topics).length} help topics and ${copied.size} local assets`);
