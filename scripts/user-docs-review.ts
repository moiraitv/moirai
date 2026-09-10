import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { normalizedSource as normalize, referencedScreenshotPaths, type UserDocPage, type UserDocsPaths } from './user-docs.js';

/** Git provides historical blobs and unified text diffs without a runtime browser dependency. */
const execute = promisify(execFile);

/** Changed image versions, copied to immutable URLs for in-place comparison. */
export interface ReviewImageChange {
	name: string;
	before: string | null;
	after: string | null;
	aspectRatio: number | null;
}

/** Verified approval comparison for one outstanding guide topic. */
export interface ReviewChange {
	id: string;
	title: string;
	href: string;
	baseline: 'approved' | 'initial' | 'unavailable';
	textDiff: string[];
	images: ReviewImageChange[];
}

/** Keep authored markup from closing VitePress's generated page-data script. */
export function reviewChangesFrontmatter(changes: ReviewChange[]): string {
	return JSON.stringify(JSON.stringify(changes).replace(/</gu, '\\u003c'));
}

/** Derive portable repository paths for Git, including alternate test guide roots. */
function relative(root: string, file: string): string {
	return path.relative(root, file).split(path.sep).join('/');
}

/** Compute a historical page's approval digest from its source and referenced image bytes. */
async function historicalPage(
	paths: UserDocsPaths,
	page: UserDocPage,
	ref: string,
	blob: (ref: string, file: string) => Promise<Buffer | null>,
): Promise<{ source: string; assets: Map<string, Buffer>; digest: string } | null> {
	const bytes = await blob(ref, path.join(paths.sourceRoot, page.relativePath));
	if (!bytes) {
		return null;
	}
	const source = bytes.toString('utf8');
	const hash = createHash('sha256').update(normalize(source));
	const assets = new Map<string, Buffer>();
	for (const file of referencedScreenshotPaths(source, paths.publicRoot)) {
		const image = await blob(ref, file);
		if (!image) {
			return null;
		}
		const name = relative(paths.publicRoot, file);
		assets.set(name, image);
		hash.update('\0').update(path.relative(paths.publicRoot, file)).update('\0').update(image);
	}
	return { source, assets, digest: hash.digest('hex') };
}

/** Produce bounded-context, escaped-at-render-time unified Markdown changes. */
async function textDiff(before: string, after: string): Promise<string[]> {
	if (normalize(before) === normalize(after)) {
		return [];
	}
	const directory = await mkdtemp(path.join(tmpdir(), 'moirai-guide-diff-'));
	try {
		const oldFile = path.join(directory, 'before.md');
		const newFile = path.join(directory, 'after.md');
		await Promise.all([writeFile(oldFile, normalize(before)), writeFile(newFile, normalize(after))]);
		let output: string;
		try {
			({ stdout: output } = await execute('git', ['diff', '--no-index', '--no-ext-diff', '--no-color', '--unified=3', '--', oldFile, newFile], { maxBuffer: 8 * 1024 * 1024 }));
		}
		catch (error) {
			const result = error as { code?: number; stdout?: string };
			if (result.code !== 1 || typeof result.stdout !== 'string') {
				throw error;
			}
			output = result.stdout;
		}
		const lines = output.trimEnd().split('\n');
		return lines.slice(lines.findIndex((line) => line.startsWith('@@')));
	}
	finally {
		await rm(directory, { recursive: true, force: true });
	}
}

/** Reserve PNG screenshot space before lazy loading, using the standard IHDR dimensions. */
function pngAspectRatio(bytes: Buffer | undefined): number | null {
	if (!bytes || bytes.length < 24
		|| !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
		|| bytes.toString('ascii', 12, 16) !== 'IHDR') {
		return null;
	}
	const width = bytes.readUInt32BE(16);
	const height = bytes.readUInt32BE(20);
	return width && height ? width / height : null;
}

/** Generate review-only assets, verifying historical content against actual approvals. */
export async function buildReviewChanges(
	paths: UserDocsPaths,
	pages: UserDocPage[],
	records: Record<string, { digest: string }>,
): Promise<ReviewChange[]> {
	const assetRoot = path.join(paths.publicRoot, 'review-assets');
	await rm(assetRoot, { recursive: true, force: true });
	await mkdir(assetRoot, { recursive: true });
	if (!pages.length) {
		return [];
	}

	// Cache shared screenshot blobs; many topics refer to the same approved images.
	const blobs = new Map<string, Promise<Buffer | null>>();
	/** Reuse historical files shared by multiple pending topics. */
	const blob = (ref: string, file: string): Promise<Buffer | null> => {
		const key = `${ref}:${relative(paths.projectRoot, file)}`;
		if (!blobs.has(key)) {
			blobs.set(key, execute('git', ['show', key], { cwd: paths.projectRoot, encoding: 'buffer', maxBuffer: 32 * 1024 * 1024 })
				.then(({ stdout }) => stdout).catch(() => null));
		}
		return blobs.get(key)!;
	};
	let refs: string[] = [];
	try {
		const { stdout } = await execute('git', ['log', '-100', '--format=%H', '--', relative(paths.projectRoot, paths.sourceRoot), relative(paths.projectRoot, paths.publicRoot)], { cwd: paths.projectRoot });
		refs = [...new Set(['HEAD', ...stdout.trim().split('\n').filter(Boolean)])];
	}
	catch {
		// Source archives and shallow histories may not contain an approved snapshot.
	}

	const changes: ReviewChange[] = [];
	for (const page of pages) {
		// Never use a historical version until the complete approval digest matches.
		let approved: Awaited<ReturnType<typeof historicalPage>> = null;
		const record = records[page.id];
		if (record) {
			for (const ref of refs) {
				const candidate = await historicalPage(paths, page, ref, blob);
				if (candidate?.digest === record.digest) {
					approved = candidate;
					break;
				}
			}
		}
		// Include additions and removals while omitting byte-identical images.
		const current = new Map<string, Buffer>();
		for (const file of referencedScreenshotPaths(page.source, paths.publicRoot)) {
			current.set(relative(paths.publicRoot, file), await readFile(file));
		}
		const images: ReviewImageChange[] = [];
		for (const name of [...new Set([...current.keys(), ...(approved?.assets.keys() ?? [])])].sort()) {
			const category = name.startsWith('icons/') ? 'icons' : 'screenshots';
			if (!page.reviewReasons.some(reason => reason === category || reason === 'initial' || reason === 'unknown')) {
				continue;
			}
			const before = approved?.assets.get(name);
			const after = current.get(name);
			if (before && after && before.equals(after)) {
				continue;
			}
			const urls: Array<string | null> = [];
			for (const bytes of [before, after]) {
				if (!bytes) {
					urls.push(null);
					continue;
				}
				const filename = `${createHash('sha256').update(bytes).digest('hex')}${path.extname(name)}`;
				await writeFile(path.join(assetRoot, filename), bytes);
				urls.push(`/help/review-assets/${filename}`);
			}
			const ratios = [pngAspectRatio(before), pngAspectRatio(after)].filter((ratio): ratio is number => ratio !== null);
			images.push({ name, before: urls[0]!, after: urls[1]!, aspectRatio: ratios.length ? Math.min(...ratios) : null });
		}
		changes.push({
			id: page.id, title: page.title, href: page.fullPath,
			baseline: approved ? 'approved' : record ? 'unavailable' : 'initial',
			textDiff: approved ? await textDiff(approved.source, page.source) : record ? [] : normalize(page.source).trimEnd().split('\n').map((line) => `+${line}`),
			images,
		});
	}
	return changes;
}
