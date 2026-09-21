import { lstat } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import path from 'node:path';
import { isIgnorableMediaIssue, type ScanIssue } from '@moirai/shared';
import type { CatalogConflictObservation, DiscoveredItem } from '../repository/contracts.js';
import { openSourceFile, SourceFileError } from '../media/source-file.js';
import { mediaProbeFingerprint } from '../media/media-probe.js';
import { stableJsonFingerprint } from '../stable-json.js';

/** Observations shared by all findings in one discovery, avoiding repeated identity reads. */
export interface MediaIssueInputs {
	media: Map<string, string>;
	/** Selected sidecar, or all candidates when none was found. */
	metadata: Map<string, string[]>;
	/** Filesystem identities captured when NFO inputs were selected or read. */
	sidecars: Map<string, string | null>;
}

/** Mark conflicting observations of one sidecar as unstable for this scan's ignore decisions. */
export function recordSidecarIdentity(inputs: MediaIssueInputs, root: string, file: string, fingerprint: string): void {
	const relativePath = path.relative(root, file).split(path.sep).join('/');
	const previous = inputs.sidecars.get(relativePath);
	inputs.sidecars.set(relativePath, previous === undefined || previous === fingerprint ? fingerprint : null);
}

/** Capture the physical identity and ordered sidecar candidates already known during discovery. */
export function recordMediaIssueInputs(inputs: MediaIssueInputs, root: string, file: string, logicalStem: string, typeKey: string, fingerprint: string): void {
	const relativePath = path.relative(root, file).split(path.sep).join('/');
	inputs.media.set(relativePath, fingerprint);
	const physicalStem = file.slice(0, -path.extname(file).length);
	inputs.metadata.set(relativePath, [...new Set([
		`${logicalStem}.nfo`, `${physicalStem}.nfo`,
		...(typeKey === 'movies' ? [path.join(path.dirname(file), 'movie.nfo')] : []),
	])].map(candidate => path.relative(root, candidate).split(path.sep).join('/')));
}

/** Bind decisions to relevant physical inputs, including unavailable and missing sidecars. */
export async function attachMediaIssueIdentities(
	root: string,
	issues: ScanIssue[],
	items: DiscoveredItem[],
	conflicts: CatalogConflictObservation[],
	inputs: MediaIssueInputs,
	signal?: AbortSignal,
): Promise<void> {
	const identities = new Map<string, Promise<string>>();
	const mediaByMetadata = new Map<string, string[]>();
	for (const [media, metadata] of inputs.metadata) {
		for (const sidecar of metadata) {
			mediaByMetadata.set(sidecar, [...(mediaByMetadata.get(sidecar) ?? []), media]);
		}
	}
	const partsByPath = new Map(items.map(item => [item.relativePath, item.parts.map(part => part.relativePath)]));
	/** Reuse observed media identities; safely inspect each additional sidecar at most once. */
	function identity(relativePath: string): Promise<string> {
		const observed = inputs.media.get(relativePath) ?? inputs.sidecars.get(relativePath);
		if (observed) {
			return Promise.resolve(observed);
		}
		let pending = identities.get(relativePath);
		if (!pending) {
			pending = inspectIdentity(relativePath);
			identities.set(relativePath, pending);
		}
		return pending;
	}
	/** Include stable availability state without incorporating human-readable diagnostic messages. */
	async function inspectIdentity(relativePath: string): Promise<string> {
		signal?.throwIfAborted();
		const file = path.resolve(root, relativePath);
		try {
			const source = await openSourceFile(root, file);
			try {
				return mediaProbeFingerprint(source.stat);
			}
			finally {
				await source.handle.close();
			}
		}
		catch (error) {
			signal?.throwIfAborted();
			return unavailableMediaIssueIdentity(file, error);
		}
	}
	for (const issue of issues) {
		if (!isIgnorableMediaIssue(issue) || !issue.path) {
			continue;
		}
		let paths = [issue.path];
		if (issue.code.startsWith('multipart_')) {
			paths = partsByPath.get(issue.path) ?? paths;
		}
		else if (issue.code === 'show_external_id_conflict') {
			const participating = conflicts.filter(conflict => conflict.paths[0] === issue.path).flatMap(conflict => conflict.paths);
			paths = [...new Set(participating.map(folder => `${folder}/tvshow.nfo`))].sort();
		}
		else if (!issue.code.startsWith('media_')) {
			paths = [...new Set([issue.path, ...(inputs.metadata.get(issue.path) ?? mediaByMetadata.get(issue.path) ?? [])])].sort();
		}
		// A shared NFO may change between consumers; do not offer an ignore for a mixed snapshot.
		if (paths.some(file => inputs.sidecars.get(file) === null)) {
			continue;
		}
		const observed: string[][] = [];
		for (const file of paths) {
			observed.push([file, await identity(file)]);
		}
		issue.ignoreState = {
			fingerprint: issue.code.startsWith('media_') ? await identity(issue.path) : stableJsonFingerprint(observed),
			ignored: false,
		};
	}
}

/** Fingerprint unavailable inputs from stable access state and their observable filesystem identity. */
export async function unavailableMediaIssueIdentity(file: string, error: unknown, observed?: Stats | null): Promise<string> {
	const info = observed === undefined ? await lstat(file).catch(() => null) : observed;
	const code = (error as NodeJS.ErrnoException).code;
	const state = error instanceof SourceFileError ? error.reason : code === 'ENOENT' ? 'missing' : code ?? 'unavailable';
	return stableJsonFingerprint({ state, identity: info ? mediaProbeFingerprint(info) : null, mode: info?.mode ?? null });
}
