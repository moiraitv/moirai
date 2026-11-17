import { realpathSync } from 'node:fs';
import path from 'node:path';
import type { MediaServerPathReplacement } from '@moirai/shared';

/**
 * Map a media-server file path onto a local file when an operator prefix matches.
 * The longest matching remote prefix wins. POSIX paths preserve case; Windows drive and UNC
 * prefixes compare without case. Unmatched paths stay remote.
 */
export function localPathForRemote(
	replacements: MediaServerPathReplacement[],
	remotePath: string,
): string | null {
	const normalizedRemote = remotePath.replace(/\\/g, '/');
	let match: { prefix: string; localPrefix: string } | null = null;
	for (const replacement of replacements) {
		const normalizedPrefix = replacement.remotePrefix.replace(/\\/g, '/');
		const prefix = normalizedPrefix.replace(/\/+$/, '') || (normalizedPrefix.startsWith('/') ? '/' : '');
		if (!prefix) {
			continue;
		}

		const windows = /^[a-z]:(?:\/|$)/iu.test(prefix) || prefix.startsWith('//');
		const candidate = windows ? normalizedRemote.toLowerCase() : normalizedRemote;
		const comparison = windows ? prefix.toLowerCase() : prefix;
		const boundary = comparison.endsWith('/') ? comparison : `${comparison}/`;
		const matched = candidate === comparison || candidate.startsWith(boundary);
		if (matched && (!match || prefix.length > match.prefix.length)) {
			match = { prefix, localPrefix: replacement.localPrefix };
		}
	}

	if (!match) {
		return null;
	}

	const remainder = normalizedRemote.slice(match.prefix.length).replace(/^\/+/, '');
	const localRoot = path.resolve(match.localPrefix);
	const segments = remainder ? remainder.split('/') : [];
	if (segments.some((segment) => segment === '' || segment === '.' || segment === '..' || path.isAbsolute(segment))) {
		return null;
	}

	const resolved = path.resolve(localRoot, ...segments);
	if (!isInside(path.resolve(localRoot), resolved)) {
		return null;
	}

	try {
		const rootReal = realpathSync(localRoot);
		const candidateReal = realpathSync(resolved);
		if (!isInside(rootReal, candidateReal)) {
			return null;
		}
	}
	catch {
		// A missing file still has to stay lexically inside the mapped folder.
	}

	return resolved;
}

/** True when candidate is the root or a descendant, after both paths are resolved. */
function isInside(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

/** Reject folder mappings whose local side is not an absolute path. */
export function assertAbsoluteLocalPrefixes(replacements: MediaServerPathReplacement[]): void {
	for (const replacement of replacements) {
		if (!path.isAbsolute(replacement.localPrefix)) {
			throw new Error(`Local playback folder must be an absolute path: ${replacement.localPrefix}`);
		}
	}
}
