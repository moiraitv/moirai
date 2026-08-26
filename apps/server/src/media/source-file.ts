import { constants, type Stats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { lstat, open, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { isPathWithinRoot } from './path-boundary.js';

/** Reasons a source path can be rejected before its bytes are consumed. */
export type SourceFileFailure
	= | 'missing'
		| 'unavailable'
		| 'outside-root'
		| 'symlink'
		| 'not-file'
		| 'changed'
		| 'too-large';

/** Safe source-file failure with a stable reason for caller-specific handling. */
export class SourceFileError extends Error {
	constructor(
		public readonly reason: SourceFileFailure,
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = 'SourceFileError';
	}
}

/** Open descriptor whose identity and root containment were checked after opening. */
export interface OpenedSourceFile {
	path: string;
	handle: FileHandle;
	stat: Stats;
}

/** Return whether two stat results identify the same filesystem object. */
function sameIdentity(
	left: { dev: number | bigint; ino: number | bigint },
	right: { dev: number | bigint; ino: number | bigint },
): boolean {
	return String(left.dev) === String(right.dev) && String(left.ino) === String(right.ino);
}

/** Convert low-level path errors into stable source access failures. */
function sourceError(error: unknown): SourceFileError {
	if (error instanceof SourceFileError) {
		return error;
	}

	const code = (error as NodeJS.ErrnoException).code;
	if (code === 'ENOENT') {
		return new SourceFileError('missing', 'Source file was not found', { cause: error });
	}

	if (code === 'ELOOP') {
		return new SourceFileError('symlink', 'Symlinked source files are not allowed', { cause: error });
	}

	return new SourceFileError('unavailable', 'Source file is temporarily unavailable', {
		cause: error,
	});
}

/**
 * Open one regular file without following its final symlink and verify that the opened object
 * still matches a canonical path inside the unchanged source root.
 */
export async function openSourceFile(
	scanRoot: string,
	candidatePath: string,
	maximumBytes?: number,
): Promise<OpenedSourceFile> {
	let handle: FileHandle | null = null;
	try {
		// Resolve and snapshot the source root before evaluating the candidate path.
		let root: string;
		let rootBefore: Stats;
		try {
			root = await realpath(scanRoot);
			rootBefore = await stat(root);
		}
		catch (error) {
			throw new SourceFileError('unavailable', 'Source root is temporarily unavailable', {
				cause: error,
			});
		}
		if (!rootBefore.isDirectory()) {
			throw new SourceFileError('unavailable', 'Source root is not a directory');
		}

		// Reject final symlinks and canonical paths outside the source root.
		const candidate = path.isAbsolute(candidatePath)
			? path.resolve(candidatePath)
			: path.resolve(scanRoot, candidatePath);
		const linkInfo = await lstat(candidate);
		if (linkInfo.isSymbolicLink()) {
			throw new SourceFileError('symlink', 'Symlinked source files are not allowed');
		}

		const resolvedBefore = await realpath(candidate);
		if (!isPathWithinRoot(root, resolvedBefore)) {
			throw new SourceFileError('outside-root', 'Source path is outside the configured library');
		}

		// Open without following links and enforce regular-file and byte-limit requirements.
		handle = await open(resolvedBefore, constants.O_RDONLY | constants.O_NOFOLLOW);
		const openedStat = await handle.stat({ bigint: false });
		if (!openedStat.isFile()) {
			throw new SourceFileError('not-file', 'Source path is not a regular file');
		}

		if (maximumBytes !== undefined && openedStat.size > maximumBytes) {
			throw new SourceFileError('too-large', 'Source file exceeds the configured byte limit');
		}

		// Re-resolve both paths and compare identities to detect replacement during opening.
		const [rootAfterPath, resolvedAfter] = await Promise.all([
			realpath(scanRoot),
			realpath(candidate),
		]);
		if (
			rootAfterPath !== root
			|| resolvedAfter !== resolvedBefore
			|| !isPathWithinRoot(root, resolvedAfter)
		) {
			throw new SourceFileError('changed', 'Source path changed while it was being opened');
		}

		const [rootAfter, pathAfter] = await Promise.all([stat(rootAfterPath), stat(resolvedAfter)]);
		if (!sameIdentity(rootBefore, rootAfter) || !sameIdentity(openedStat, pathAfter)) {
			throw new SourceFileError('changed', 'Source path changed while it was being opened');
		}

		// Transfer descriptor ownership to the caller only after every check succeeds.
		const result = { path: resolvedAfter, handle, stat: openedStat };
		handle = null;
		return result;
	}
	catch (error) {
		throw sourceError(error);
	}
	finally {
		await handle?.close().catch(() => undefined);
	}
}

/** Read one bounded source file entirely through its validated descriptor. */
export async function readSourceFile(
	scanRoot: string,
	candidatePath: string,
	maximumBytes: number,
	signal?: AbortSignal,
): Promise<{ content: Buffer; path: string; stat: OpenedSourceFile['stat'] }> {
	const source = await openSourceFile(scanRoot, candidatePath, maximumBytes);
	try {
		return {
			content: await source.handle.readFile({ signal }),
			path: source.path,
			stat: source.stat,
		};
	}
	finally {
		await source.handle.close();
	}
}
