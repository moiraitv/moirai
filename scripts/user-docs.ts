import { createHash } from 'node:crypto';
import { access, cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import matter from 'gray-matter';
import MarkdownIt from 'markdown-it';
import { buildReviewChanges, reviewChangesFrontmatter } from './user-docs-review.js';
import { userDocsTermBadges } from './user-docs-term-badges.js';
import { reviewHighlights } from './user-docs-highlights.js';
import { helpTopicIds } from '../apps/web/src/help.js';
import { helpReviewLabel, type HelpReviewReason } from '../apps/web/src/help-review.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const docsRoot = path.join(projectRoot, 'apps/docs');
const sourceRoot = path.join(docsRoot, 'src');
const publicRoot = path.join(sourceRoot, 'public');
const reviewPath = path.join(docsRoot, 'reviews.json');
const generatedManifestPath = path.join(publicRoot, 'contextual-help.json');
const generatedReviewPath = path.join(sourceRoot, 'review.md');
const guideDistPath = path.join(docsRoot, 'dist');
const bundledGuidePath = path.join(projectRoot, 'apps/web/dist/help');

/** Filesystem boundaries used to load and update one user-guide checkout. */
export interface UserDocsPaths {
	projectRoot: string;
	sourceRoot: string;
	publicRoot: string;
	reviewPath: string;
	generatedManifestPath: string;
	generatedReviewPath: string;
	requiredContextualTopicIds: readonly string[];
}

/** Default user-guide paths for the current repository checkout. */
export const defaultUserDocsPaths: UserDocsPaths = {
	projectRoot,
	sourceRoot,
	publicRoot,
	reviewPath,
	generatedManifestPath,
	generatedReviewPath,
	requiredContextualTopicIds: helpTopicIds,
};

/** One human approval tied to the exact current page digest. */
interface ReviewRecord {
	digest: string;
	reviewedAt: string;
	components?: Record<'text' | 'screenshots' | 'icons', { digest: string; reviewedAt: string }>;
}

/** Versioned durable registry of explicitly approved guide pages. */
interface ReviewRegistry {
	version: 1 | 2;
	reviews: Record<string, ReviewRecord>;
}

/** Validated authored page and its derived public and review metadata. */
export interface UserDocPage {
	id: string;
	title: string;
	description: string;
	contextual: boolean;
	relativePath: string;
	fullPath: string;
	source: string;
	body: string;
	digest: string;
	componentDigests: Record<'text' | 'screenshots' | 'icons', string>;
	reviewReasons: HelpReviewReason[];
	reviewStatus: 'needs-review' | 'reviewed';
}

/** Recursively collect authored Markdown without including generated review output. */
async function markdownFiles(directory: string, excludedPath: string): Promise<string[]> {
	const entries = await readdir(directory, { withFileTypes: true });
	const nested = await Promise.all(entries.map(async (entry) => {
		const candidate = path.join(directory, entry.name);
		if (entry.isDirectory()) {
			return markdownFiles(candidate, excludedPath);
		}
		if (entry.isFile() && entry.name.endsWith('.md') && candidate !== excludedPath) {
			return [candidate];
		}
		return [];
	}));

	return nested.flat().sort();
}

/** Normalize authored text so platform line endings do not invalidate a review. */
export function normalizedSource(value: string): string {
	return `${value.replace(/\r\n?/gu, '\n').trimEnd()}\n`;
}

/** Resolve local screenshots and icons referenced by one guide page. */
export function referencedScreenshotPaths(source: string, assetsRoot = publicRoot): string[] {
	const matches = source.matchAll(/!\[[^\]]*\]\((\/(?:help\/)?(?:screenshots|icons)\/[^)\s]+)(?:\s+"[^"]*")?\)/gu);
	const assetPaths = [...matches]
		.map((match) => match[1])
		.filter((value): value is string => Boolean(value));
	return [...new Set(assetPaths.map((assetPath) => path.join(
		assetsRoot,
		assetPath.replace(/^\/help\//u, '/').slice(1),
	)))]
		.sort();
}

/** Hash the page source and exact bytes of every screenshot and icon it presents. */
export async function pageDigest(source: string, assetsRoot = publicRoot): Promise<string> {
	const hash = createHash('sha256').update(normalizedSource(source));
	for (const screenshotPath of referencedScreenshotPaths(source, assetsRoot)) {
		hash.update('\0');
		hash.update(path.relative(assetsRoot, screenshotPath));
		hash.update('\0');
		hash.update(await readFile(screenshotPath));
	}
	return hash.digest('hex');
}

/** Hash independent approval categories using portable, sorted asset references. */
export async function pageComponentDigests(source: string, assetsRoot = publicRoot): Promise<UserDocPage['componentDigests']> {
	const hashes = { screenshots: createHash('sha256'), icons: createHash('sha256') };
	for (const assetPath of referencedScreenshotPaths(source, assetsRoot)) {
		const relative = path.relative(assetsRoot, assetPath).split(path.sep).join('/');
		const category = relative.startsWith('icons/') ? 'icons' : 'screenshots';
		hashes[category].update(JSON.stringify([relative, (await readFile(assetPath)).toString('base64')]));
	}
	return {
		text: createHash('sha256').update(normalizedSource(source)).digest('hex'),
		screenshots: hashes.screenshots.digest('hex'),
		icons: hashes.icons.digest('hex'),
	};
}

/** Determine review scope without guessing a legacy approval's component baselines. */
function reviewReasons(record: ReviewRecord | undefined, digest: string, components: UserDocPage['componentDigests']): HelpReviewReason[] {
	if (!record) {
		return ['initial'];
	}
	if (!record.components) {
		return record.digest === digest ? [] : ['unknown'];
	}
	return (['text', 'screenshots', 'icons'] as const)
		.filter((category) => record.components?.[category]?.digest !== components[category]);
}

/** Preserve a human approval time while recording its verified component baselines. */
function componentApprovals(page: UserDocPage, reviewedAt: string): NonNullable<ReviewRecord['components']> {
	return {
		text: { digest: page.componentDigests.text, reviewedAt },
		screenshots: { digest: page.componentDigests.screenshots, reviewedAt },
		icons: { digest: page.componentDigests.icons, reviewedAt },
	};
}

/** Explicitly migrate only matching legacy digests; never approve changed content. */
export async function migrateReviews(paths = defaultUserDocsPaths): Promise<void> {
	const pages = await loadUserDocPages(paths);
	const registry = await loadReviewRegistry(paths.reviewPath);
	for (const page of pages) {
		const record = registry.reviews[page.id];
		if (record && !record.components && record.digest === page.digest) {
			record.components = componentApprovals(page, record.reviewedAt);
		}
	}
	registry.version = 2;
	const serialized = `${JSON.stringify(registry, null, 2)}\n`;
	if (serialized !== await readFile(paths.reviewPath, 'utf8')) {
		await writeFile(paths.reviewPath, serialized);
	}
}

/** Convert an authored Markdown path to its public VitePress HTML path. */
function publicPagePath(relativePath: string): string {
	const withoutExtension = relativePath.replace(/\.md$/u, '');
	if (withoutExtension === 'index') {
		return '/help/';
	}
	return `/help/${withoutExtension}.html`;
}

/** Load the persisted approvals, rejecting incompatible registry versions. */
export async function loadReviewRegistry(filePath = reviewPath): Promise<ReviewRegistry> {
	const parsed = JSON.parse(await readFile(filePath, 'utf8')) as Partial<ReviewRegistry>;
	if (![1, 2].includes(parsed.version ?? 0) || !parsed.reviews || Array.isArray(parsed.reviews)) {
		throw new Error('apps/docs/reviews.json must contain a version 1 or 2 review registry');
	}
	return parsed as ReviewRegistry;
}

/** Load and validate every authored user-guide page with its derived review state. */
export async function loadUserDocPages(paths = defaultUserDocsPaths): Promise<UserDocPage[]> {
	const registry = await loadReviewRegistry(paths.reviewPath);
	const files = await markdownFiles(paths.sourceRoot, paths.generatedReviewPath);
	const pages: UserDocPage[] = [];
	const ids = new Set<string>();

	for (const file of files) {
		const source = await readFile(file, 'utf8');
		const parsed = matter(source);
		const id = typeof parsed.data.id === 'string' ? parsed.data.id.trim() : '';
		const title = typeof parsed.data.title === 'string' ? parsed.data.title.trim() : '';
		const description = typeof parsed.data.description === 'string'
			? parsed.data.description.trim()
			: '';
		if (!id || !title || !description) {
			throw new Error(`${path.relative(paths.projectRoot, file)} requires id, title, and description frontmatter`);
		}
		if (ids.has(id)) {
			throw new Error(`Duplicate user-documentation id: ${id}`);
		}
		ids.add(id);

		for (const screenshotPath of referencedScreenshotPaths(source, paths.publicRoot)) {
			await access(screenshotPath);
		}

		const relativePath = path.relative(paths.sourceRoot, file).split(path.sep).join('/');
		const digest = await pageDigest(source, paths.publicRoot);
		const componentDigests = await pageComponentDigests(source, paths.publicRoot);
		const reasons = reviewReasons(registry.reviews[id], digest, componentDigests);
		pages.push({
			id,
			title,
			description,
			contextual: parsed.data.contextual === true,
			relativePath,
			fullPath: publicPagePath(relativePath),
			source,
			body: parsed.content,
			digest,
			componentDigests,
			reviewReasons: reasons,
			reviewStatus: reasons.length ? 'needs-review' : 'reviewed',
		});
	}

	const contextualIds = new Set(pages.filter((page) => page.contextual).map((page) => page.id));
	const missingTopics = paths.requiredContextualTopicIds.filter((id) => !contextualIds.has(id));
	if (missingTopics.length) {
		throw new Error(`Contextual help mappings are missing authored topics: ${missingTopics.join(', ')}`);
	}

	const pagePaths = new Set(pages.map((page) => page.fullPath));
	for (const page of pages) {
		const links = page.source.matchAll(/(?<!!)\[[^\]]+\]\(([^)\s]+)(?:\s+"[^"]*")?\)/gu);
		for (const match of links) {
			const target = match[1];
			if (!target || /^(?:https?:|mailto:|#)/u.test(target)) {
				continue;
			}
			const publicTarget = target.startsWith('/help/')
				? target
				: target === '/'
					? '/help/'
					: `/help${target}.html`;
			if (!pagePaths.has(publicTarget)) {
				throw new Error(`${page.relativePath} links to missing guide page ${target}`);
			}
		}
	}

	return pages;
}

/** Render restricted, repository-authored Markdown for the in-app help drawer. */
function contextualHtml(body: string): string {
	const markdown = new MarkdownIt({ html: false, linkify: true, typographer: true });
	markdown.use(userDocsTermBadges);
	markdown.renderer.rules.image = (tokens, index, options, _env, renderer) => {
		const token = tokens[index]!;
		const source = token.attrGet('src');
		if (source?.startsWith('/screenshots/') || source?.startsWith('/icons/')) {
			token.attrSet('src', `/help${source}`);
		}
		token.attrSet('alt', renderer.renderInlineAsText(token.children ?? [], options, _env));
		return renderer.renderToken(tokens, index, options);
	};
	markdown.renderer.rules.link_open = (tokens, index, options, _env, renderer) => {
		const token = tokens[index]!;
		const href = token.attrGet('href');
		if (href?.startsWith('/') && !href.startsWith('//') && !href.startsWith('/help/')) {
			const [pathname, anchor] = href.split('#');
			const fullPath = pathname === '/' ? '/help/' : `/help${pathname}.html`;
			token.attrSet('href', `${fullPath}${anchor ? `#${anchor}` : ''}`);
		}
		return renderer.renderToken(tokens, index, options);
	};
	const withoutTitle = body.replace(/^\s*#\s+[^\n]+\n+/u, '');
	return markdown.render(withoutTitle);
}

/** Write the public help manifest and generated review dashboard. */
export async function writeUserDocsManifest(paths = defaultUserDocsPaths): Promise<void> {
	const pages = await loadUserDocPages(paths);
	const packageJson = JSON.parse(await readFile(path.join(paths.projectRoot, 'package.json'), 'utf8')) as { version: string };
	const outstanding = pages.filter((page) => page.reviewStatus === 'needs-review');
	const changes = await buildReviewChanges(paths, outstanding, (await loadReviewRegistry(paths.reviewPath)).reviews);
	const highlights = new Map(changes.map((change) => [change.id, reviewHighlights(pages.find((page) => page.id === change.id)!.source, change)]));
	const manifest = {
		version: 1,
		guideVersion: packageJson.version,
		pages: pages.map(({ id, title, fullPath, reviewStatus, reviewReasons }) => ({ id, title, path: fullPath, reviewStatus, reviewReasons, reviewHighlights: highlights.get(id) })),
		topics: Object.fromEntries(pages.filter((page) => page.contextual).map((page) => [page.id, {
			id: page.id,
			title: page.title,
			description: page.description,
			html: contextualHtml(page.body),
			fullPath: page.fullPath,
			reviewStatus: page.reviewStatus,
			reviewReasons: page.reviewReasons,
		}])),
	};
	const reviewLines = outstanding.length
		? outstanding.map((page) => `- [${page.title}](#review-${page.id}) — \`${page.id}\` — ${helpReviewLabel(page.reviewReasons)}`)
		: ['All user-guide pages have been reviewed.'];
	const reviewPage = `---\nreviewChanges: ${reviewChangesFrontmatter(changes)}\ntitle: Documentation review status\ndescription: Pages awaiting human review before production packaging.\nsidebar: false\n---\n\n# Documentation review status\n\n**${outstanding.length} of ${pages.length} pages need review.**\n\n${reviewLines.join('\n')}\n\n<ReviewChanges />\n`;

	await mkdir(paths.publicRoot, { recursive: true });
	await writeFile(paths.generatedManifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
	await writeFile(paths.generatedReviewPath, reviewPage);
}

/** Print unreviewed pages for people or automation. */
export async function listOutstandingReviews(
	json = false,
	paths = defaultUserDocsPaths,
): Promise<UserDocPage[]> {
	const outstanding = (await loadUserDocPages(paths)).filter((page) => page.reviewStatus === 'needs-review');
	if (json) {
		console.log(JSON.stringify(outstanding.map(({ id, title, relativePath, digest, reviewReasons }) => ({
			id,
			title,
			relativePath,
			digest,
			reviewReasons,
		})), null, 2));
	}
	else if (!outstanding.length) {
		console.log('All user-guide pages have been reviewed.');
	}
	else {
		console.log(`${outstanding.length} user-guide page(s) need review:`);
		for (const page of outstanding) {
			console.log(`- ${page.id}: ${page.title} (${page.relativePath}) — ${helpReviewLabel(page.reviewReasons)}`);
		}
	}
	return outstanding;
}

/** Record explicit approval for named pages or every current page digest. */
export async function approveReviews(
	ids: string[],
	approveAll: boolean,
	paths = defaultUserDocsPaths,
): Promise<void> {
	const pages = await loadUserDocPages(paths);
	const selected = approveAll ? pages : pages.filter((page) => ids.includes(page.id));
	const missing = ids.filter((id) => !pages.some((page) => page.id === id));
	if (missing.length) {
		throw new Error(`Unknown user-documentation id(s): ${missing.join(', ')}`);
	}
	if (!selected.length) {
		throw new Error('Specify one or more topic ids, or pass --all');
	}

	const registry = await loadReviewRegistry(paths.reviewPath);
	registry.version = 2;
	const reviewedAt = new Date().toISOString();
	for (const page of selected) {
		registry.reviews[page.id] = { digest: page.digest, reviewedAt, components: componentApprovals(page, reviewedAt) };
	}
	await writeFile(paths.reviewPath, `${JSON.stringify(registry, null, 2)}\n`);
	console.log(`Approved ${selected.length} current user-guide page digest(s).`);
}

/** Reject a release build when any current guide digest lacks explicit approval. */
export async function assertUserDocsReviewed(paths = defaultUserDocsPaths): Promise<void> {
	const outstanding = await listOutstandingReviews(false, paths);
	if (outstanding.length) {
		throw new Error('Production build blocked by unreviewed user documentation.');
	}
}

/** Copy the built guide into the web distribution served by ordinary and containerized runs. */
export async function bundleUserDocs(): Promise<void> {
	await access(path.join(guideDistPath, 'index.html'));
	await rm(bundledGuidePath, { recursive: true, force: true });
	await mkdir(path.dirname(bundledGuidePath), { recursive: true });
	await cp(guideDistPath, bundledGuidePath, { recursive: true });
}

/** Run the requested user-documentation maintenance command. */
async function main(): Promise<void> {
	const [command, ...args] = process.argv.slice(2);
	if (command === 'migrate') {
		await migrateReviews();
		return;
	}
	if (command === 'manifest') {
		await writeUserDocsManifest();
		return;
	}
	if (command === 'check') {
		const pages = await loadUserDocPages();
		console.log(`Validated ${pages.length} user-guide pages.`);
		return;
	}
	if (command === 'list') {
		await listOutstandingReviews(args.includes('--json'));
		return;
	}
	if (command === 'approve') {
		await approveReviews(args.filter((value) => value !== '--all'), args.includes('--all'));
		return;
	}
	if (command === 'review-check') {
		await assertUserDocsReviewed();
		return;
	}
	if (command === 'bundle') {
		await bundleUserDocs();
		return;
	}
	throw new Error(`Unknown user-documentation command: ${command ?? '(missing)'}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	});
}
