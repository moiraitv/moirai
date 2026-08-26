import path from 'node:path';

/** Check whether a normalized or canonical path is the root or one of its descendants. */
export function isPathWithinRoot(root: string, candidate: string): boolean {
	return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}
