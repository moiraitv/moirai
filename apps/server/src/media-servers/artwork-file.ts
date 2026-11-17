import { randomUUID } from 'node:crypto';
import { open, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SourceFileError, type OpenedSourceFile } from '../media/source-file.js';
import { PROVIDER_IMAGE_PREFIX } from './catalog.js';
import { openMediaServerClient } from './client.js';
import { createMediaFetch, mediaRequestSignal, MediaServerRequestError } from './http.js';
import type { MediaServerRepository } from '../repository/media-servers.js';

/** Opened provider image plus the temporary file that must be removed after the cache reads it. */
export interface ProviderArtworkFile {
	file: OpenedSourceFile;
	cleanup: () => Promise<void>;
}

/**
 * Download one provider image into a temporary file the artwork cache can read.
 * The credential stays on the request and is not written into the file name.
 */
export async function openProviderArtwork(
	servers: Pick<MediaServerRepository, 'getMediaServerConnection'>,
	mediaServerId: string,
	storedPath: string,
	maximumBytes: number,
	signal?: AbortSignal,
): Promise<ProviderArtworkFile> {
	const imagePath = storedPath.startsWith(PROVIDER_IMAGE_PREFIX)
		? storedPath.slice(PROVIDER_IMAGE_PREFIX.length)
		: storedPath;
	const connection = await servers.getMediaServerConnection(mediaServerId);
	if (!connection) {
		throw new SourceFileError('unavailable', 'Media server is no longer saved');
	}

	const abort = mediaRequestSignal(signal);
	const destination = path.join(os.tmpdir(), `moirai-artwork-${randomUUID()}`);
	let handle = await open(destination, 'wx+', 0o600);
	try {
		const fetch = createMediaFetch(connection.allowInsecureTls);
		const client = openMediaServerClient(fetch, connection);
		const request = client.artworkRequest(imagePath);
		const response = await fetch(request.url, {
			headers: { ...request.headers, 'User-Agent': 'Moirai' },
			signal: abort,
		});
		if (!response.ok) {
			await response.body?.cancel();
			throw new SourceFileError(response.status === 404 ? 'missing' : 'unavailable', 'Artwork source is unavailable');
		}

		const advertised = Number(response.headers.get('content-length'));
		if (Number.isFinite(advertised) && advertised > maximumBytes) {
			await response.body?.cancel();
			throw new SourceFileError('too-large', 'Artwork exceeds configured rendering limits');
		}

		let bytes = 0;
		if (response.body) {
			const reader = response.body.getReader();
			try {
				for (;;) {
					const chunk = await reader.read();
					if (chunk.done) {
						break;
					}

					bytes += chunk.value.byteLength;
					if (bytes > maximumBytes) {
						throw new SourceFileError('too-large', 'Artwork exceeds configured rendering limits');
					}

					await handle.writeFile(chunk.value);
				}
			}
			catch (error) {
				await reader.cancel().catch(() => undefined);
				throw error;
			}
			finally {
				reader.releaseLock();
			}
		}

		await handle.close();
		handle = await open(destination, 'r');
		return {
			file: { path: destination, handle, stat: await handle.stat() },
			cleanup: async () => {
				await handle.close().catch(() => undefined);
				await unlink(destination).catch(() => undefined);
			},
		};
	}
	catch (error) {
		await handle.close().catch(() => undefined);
		await unlink(destination).catch(() => undefined);
		if (error instanceof SourceFileError) {
			throw error;
		}

		const message = error instanceof MediaServerRequestError ? error.message : 'Artwork source failed or timed out';
		throw new SourceFileError('unavailable', message);
	}
}
