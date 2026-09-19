import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { ARTWORK_EXTENSIONS } from '../artwork/artwork-formats.js';
import { isPathWithinRoot } from '../media/path-boundary.js';

/** Stop scan artwork lookups promptly after cooperative cancellation. */
function throwIfCancelled(signal?: AbortSignal): void {
	signal?.throwIfAborted();
}

/** Return the first readable non-symlink file from the candidates. */
export async function existingFile(candidates: string[], signal?: AbortSignal): Promise<string | null> {
	for (const candidate of candidates) {
		throwIfCancelled(signal);
		try {
			if ((await lstat(candidate)).isFile()) {
				return candidate;
			}
		}
		catch {
			// Missing artwork is expected and handled by the SPA placeholder.
		}
	}
	return null;
}

/** Resolve conventional artwork without crossing the library boundary. */
export async function existingArtwork(stems: string[], signal?: AbortSignal): Promise<string | null> {
	return existingFile(
		stems.flatMap((stem) => ARTWORK_EXTENSIONS.map((extension) => `${stem}${extension}`)),
		signal,
	);
}

/** Resolve poster, landscape, and fanart files from conventional stems. */
export async function existingArtworkRoles(
	posterStems: string[],
	landscapeStems: string[],
	fanartStems: string[],
	signal?: AbortSignal,
): Promise<{ poster: string | null; landscape: string | null; fanart: string | null }> {
	const [poster, landscape, fanart] = await Promise.all([
		existingArtwork(posterStems, signal),
		existingArtwork(landscapeStems, signal),
		existingArtwork(fanartStems, signal),
	]);
	return { poster, landscape, fanart };
}

/** Resolve a safe local primary-artwork reference relative to its owning NFO. */
export async function referencedArtwork(
	scanRoot: string,
	nfoPath: string | null,
	references: string[],
	signal?: AbortSignal,
): Promise<string | null> {
	if (!nfoPath) {
		return null;
	}

	const candidates = references.flatMap((reference) => {
		if (/^[a-z][a-z0-9+.-]*:/i.test(reference) || path.isAbsolute(reference)) {
			return [];
		}

		const candidate = path.resolve(path.dirname(nfoPath), reference);
		return isPathWithinRoot(scanRoot, candidate) ? [candidate] : [];
	});
	return existingFile(candidates, signal);
}

/** Conventional item poster, landscape, and fanart stems beside a media file. */
export function itemArtworkStems(
	logicalStem: string,
	stem: string,
	itemDirectory: string,
	typeKey: string,
): { poster: string[]; landscape: string[]; fanart: string[] } {
	return {
		poster: [
			`${logicalStem}-poster`,
			`${logicalStem}-cover`,
			`${logicalStem}-default`,
			...(typeKey === 'shows' ? [] : [`${logicalStem}-movie`]),
			logicalStem,
			`${stem}-poster`,
			path.join(itemDirectory, 'poster'),
			path.join(itemDirectory, 'folder'),
			path.join(itemDirectory, 'cover'),
			path.join(itemDirectory, 'default'),
			...(typeKey === 'movies' ? [path.join(itemDirectory, 'movie')] : []),
			`${logicalStem}-thumb`,
			`${stem}-thumb`,
			path.join(itemDirectory, 'thumb'),
		],
		landscape: [
			`${logicalStem}-landscape`,
			`${stem}-landscape`,
			path.join(itemDirectory, 'landscape'),
		],
		fanart: [
			`${logicalStem}-fanart`,
			`${stem}-fanart`,
			path.join(itemDirectory, 'fanart'),
		],
	};
}
