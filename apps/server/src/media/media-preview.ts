import type { Stats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import type { MediaFileOwner } from '../repository/contracts.js';
import { openSourceFile, SourceFileError } from './source-file.js';

/** Validated media file and MIME metadata available for browser preview. */
export interface ResolvedMediaFile {
	path: string;
	stat: Stats;
	handle: FileHandle;
}

/** Inclusive byte range selected from an HTTP Range header. */
export interface MediaByteRange {
	start: number;
	end: number;
}

/** Report safe, expected failures while resolving or streaming source media. */
export class MediaPreviewError extends Error {
	constructor(
		message: string,
		public readonly statusCode: 403 | 404 | 409 | 416 | 503,
	) {
		super(message);
	}
}

/** Browser media types selected from indexed video suffixes. */
const MIME_TYPES: Readonly<Record<string, string>> = {
	'.avi': 'video/x-msvideo',
	'.m2ts': 'video/mp2t',
	'.m4v': 'video/mp4',
	'.mkv': 'video/x-matroska',
	'.mov': 'video/quicktime',
	'.mp4': 'video/mp4',
	'.mpeg': 'video/mpeg',
	'.mpg': 'video/mpeg',
	'.ts': 'video/mp2t',
	'.webm': 'video/webm',
};

/** Select the browser media type associated with a video filename. */
export function mediaMimeType(file: string): string {
	return MIME_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

/** Parse and clamp a single HTTP byte range to the media file size. */
export function parseMediaRange(value: string | undefined, size: number): MediaByteRange | null {
	if (!value) {
		return null;
	}

	const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
	if (!match || (match[1] === '' && match[2] === '')) {
		throw new MediaPreviewError('Requested media range is not satisfiable', 416);
	}

	const startText = match[1]!;
	const endText = match[2]!;
	if (startText === '') {
		const suffixLength = Number(endText);
		if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0 || size <= 0) {
			throw new MediaPreviewError('Requested media range is not satisfiable', 416);
		}

		return { start: Math.max(0, size - suffixLength), end: size - 1 };
	}

	const start = Number(startText);
	const requestedEnd = endText === '' ? size - 1 : Number(endText);
	if (
		!Number.isSafeInteger(start)
		|| !Number.isSafeInteger(requestedEnd)
		|| start < 0
		|| start >= size
		|| requestedEnd < start
	) {
		throw new MediaPreviewError('Requested media range is not satisfiable', 416);
	}

	return { start, end: Math.min(requestedEnd, size - 1) };
}

/** Resolve a catalog item to a verified regular file within its library root. */
export async function resolveMediaFile(owner: MediaFileOwner): Promise<ResolvedMediaFile> {
	if (owner.sourceType !== 'on-disk') {
		throw new MediaPreviewError('Preview is not supported for this source type', 409);
	}

	try {
		const source = await openSourceFile(owner.scanRoot, owner.relativePath);
		return { path: source.path, stat: source.stat, handle: source.handle };
	}
	catch (error) {
		if (!(error instanceof SourceFileError)) {
			throw error;
		}

		if (error.reason === 'outside-root' || error.reason === 'symlink') {
			throw new MediaPreviewError('Media path is outside the configured library', 403);
		}

		if (error.reason === 'missing' || error.reason === 'not-file') {
			throw new MediaPreviewError('Media file was not found', 404);
		}

		throw new MediaPreviewError('Media source is temporarily unavailable', 503);
	}
}
