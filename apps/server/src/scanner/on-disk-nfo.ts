import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { MAX_NFO_BYTES, type ScanIssue } from '@moirai/shared';
import { parseKodiNfo, type ParsedNfo } from './nfo.js';
import { readSourceFile, SourceFileError } from '../media/source-file.js';
import { mediaProbeFingerprint } from '../media/media-probe.js';
import { internalErrorMessage } from '../error-message.js';
import { recordSidecarIdentity, unavailableMediaIssueIdentity, type MediaIssueInputs } from './media-issue-identity.js';

/** Match the scanner's portable relative-path keys. */
function normalizeRelative(root: string, file: string): string {
	return path.relative(root, file).split(path.sep).join('/');
}

/** Retain missing-sidecar observations at selection time, before another file can appear. */
async function selectNfo(candidates: string[], root: string, inputs: MediaIssueInputs, signal?: AbortSignal): Promise<string | null> {
	for (const file of candidates) {
		signal?.throwIfAborted();
		try {
			const info = await lstat(file);
			if (info.isFile()) {
				return file;
			}
			recordSidecarIdentity(inputs, root, file, await unavailableMediaIssueIdentity(file, new SourceFileError('not-file', 'Not a regular NFO file'), info));
		}
		catch (error) {
			signal?.throwIfAborted();
			recordSidecarIdentity(inputs, root, file, await unavailableMediaIssueIdentity(file, error, null));
		}
	}
	return null;
}

/** Bind metadata diagnostics to the descriptor snapshot read, including parsing failures. */
async function readObservedNfo(root: string, file: string, inputs: MediaIssueInputs, signal?: AbortSignal) {
	try {
		const source = await readSourceFile(root, file, MAX_NFO_BYTES, signal);
		recordSidecarIdentity(inputs, root, file, mediaProbeFingerprint(source.stat));
		return source;
	}
	catch (error) {
		signal?.throwIfAborted();
		recordSidecarIdentity(inputs, root, file, await unavailableMediaIssueIdentity(file, error));
		throw error;
	}
}

/** Retrieve nfo for the library scan. */
export async function readNfo(
	file: string,
	scanRoot: string,
	logicalStem: string,
	typeKey: string,
	inputs: MediaIssueInputs,
	signal?: AbortSignal,
): Promise<{
	parsed: ParsedNfo | null;
	path: string | null;
	status: 'complete' | 'incomplete' | 'invalid';
	issue: ScanIssue | null;
}> {
	const stem = file.slice(0, -path.extname(file).length);
	const candidates = [
		`${logicalStem}.nfo`,
		...(logicalStem === stem ? [] : [`${stem}.nfo`]),
		...(typeKey === 'movies' ? [path.join(path.dirname(file), 'movie.nfo')] : []),
	];
	const nfoPath = await selectNfo(candidates, scanRoot, inputs, signal);
	if (!nfoPath) {
		return {
			parsed: null,
			path: null,
			status: 'incomplete',
			issue: {
				path: file,
				code: 'nfo_missing',
				message: 'No sidecar NFO was found; metadata was derived from the filename.',
				severity: 'warning',
			},
		};
	}

	inputs.metadata.set(normalizeRelative(scanRoot, file), [normalizeRelative(scanRoot, nfoPath)]);
	try {
		const source = await readObservedNfo(scanRoot, nfoPath, inputs, signal);
		return {
			parsed: parseKodiNfo(source.content.toString('utf8')),
			path: source.path,
			status: 'complete',
			issue: null,
		};
	}
	catch (error) {
		if (signal?.aborted) {
			throw error;
		}

		const tooLarge = error instanceof SourceFileError && error.reason === 'too-large';
		return {
			parsed: null,
			path: nfoPath,
			status: 'invalid',
			issue: {
				path: nfoPath,
				code: tooLarge ? 'nfo_too_large' : 'nfo_invalid',
				message: tooLarge
					? `NFO exceeds the ${MAX_NFO_BYTES} byte ingestion limit.`
					: internalErrorMessage(error),
				severity: 'warning',
			},
		};
	}
}

/** Retrieve group-level NFO metadata for the library scan. */
export async function readGroupNfo(
	file: string,
	scanRoot: string,
	issues: ScanIssue[],
	inputs: MediaIssueInputs,
	signal?: AbortSignal,
): Promise<ParsedNfo | null> {
	try {
		const source = await readObservedNfo(scanRoot, file, inputs, signal);
		const parsed = parseKodiNfo(source.content.toString('utf8'));
		if (parsed.truncatedFields.length > 0) {
			issues.push({
				path: normalizeRelative(scanRoot, file),
				code: 'metadata_truncated',
				message: `Metadata exceeded documented limits: ${parsed.truncatedFields.join(', ')}.`,
				severity: 'warning',
			});
		}
		if (parsed.invalidFields.length > 0) {
			issues.push({
				path: normalizeRelative(scanRoot, file),
				code: 'metadata_invalid',
				message: `Invalid metadata values were ignored: ${parsed.invalidFields.join(', ')}.`,
				severity: 'warning',
			});
		}
		return parsed;
	}
	catch (error) {
		if (signal?.aborted) {
			throw error;
		}

		if (error instanceof SourceFileError && error.reason === 'missing') {
			return null;
		}

		const tooLarge = error instanceof SourceFileError && error.reason === 'too-large';
		issues.push({
			path: normalizeRelative(scanRoot, file),
			code: tooLarge ? 'nfo_too_large' : 'tvshow_nfo_invalid',
			message: tooLarge
				? `NFO exceeds the ${MAX_NFO_BYTES} byte ingestion limit.`
				: internalErrorMessage(error),
			severity: 'warning',
		});
		return null;
	}
}

