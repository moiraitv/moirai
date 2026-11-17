import type { MediaServerRepository } from '../repository/media-servers.js';
import { SourceFileError } from '../media/source-file.js';
import { openProviderArtwork, type ProviderArtworkFile } from './artwork-file.js';
import { mediaRequestSignal } from './http.js';
import { MEDIA_ARTWORK_QUEUE_LIMIT } from './limits.js';

/** One bounded waiter removed when its request deadline or browser cancellation fires. */
interface ArtworkWaiter {
	resume: () => void;
}

/** Safe backpressure failure for a saturated provider download queue. */
export class ProviderArtworkCapacityError extends Error {
	readonly statusCode = 503;
	constructor() {
		super('Provider artwork downloads are busy; retry shortly');
	}
}

/**
 * Bound provider downloads and temporary assets across concurrent public artwork requests.
 * A permit remains owned until the cache has consumed and removed the downloaded source file.
 */
export class ProviderArtworkDownloads {
	private active = 0;
	private readonly waiting: ArtworkWaiter[] = [];

	constructor(private readonly concurrency = 4) {}

	/** Admit, download, and transfer permit ownership to the source file's cleanup callback. */
	async open(
		servers: Pick<MediaServerRepository, 'getMediaServerConnection'>,
		mediaServerId: string,
		storedPath: string,
		maximumBytes: number,
		callerSignal?: AbortSignal,
	): Promise<ProviderArtworkFile> {
		const signal = mediaRequestSignal(callerSignal);
		await this.acquire(signal);
		try {
			const artwork = await openProviderArtwork(servers, mediaServerId, storedPath, maximumBytes, signal);
			let cleaned = false;
			return {
				file: artwork.file,
				cleanup: async () => {
					if (cleaned) {
						return;
					}

					cleaned = true;
					try {
						await artwork.cleanup();
					}
					finally {
						this.release();
					}
				},
			};
		}
		catch (error) {
			this.release();
			throw error;
		}
	}

	/** Wait within the request's existing deadline, rejecting excess waiting work immediately. */
	private async acquire(signal: AbortSignal): Promise<void> {
		if (signal.aborted) {
			throw new SourceFileError('unavailable', 'Artwork request was cancelled or timed out');
		}
		if (this.active < this.concurrency) {
			this.active += 1;
			return;
		}
		if (this.waiting.length >= MEDIA_ARTWORK_QUEUE_LIMIT) {
			throw new ProviderArtworkCapacityError();
		}

		await new Promise<void>((resolve, reject) => {
			/** Remove abandoned work before another request can hand it a permit. */
			const cancel = (): void => {
				const index = this.waiting.indexOf(waiter);
				if (index >= 0) {
					this.waiting.splice(index, 1);
				}

				reject(new SourceFileError('unavailable', 'Artwork request was cancelled or timed out'));
			};
			const waiter: ArtworkWaiter = {
				resume: () => {
					signal.removeEventListener('abort', cancel);
					resolve();
				},
			};
			signal.addEventListener('abort', cancel, { once: true });
			this.waiting.push(waiter);
		});
	}

	/** Transfer the released permit to one waiting request, or return it to available capacity. */
	private release(): void {
		const next = this.waiting.shift();
		if (next) {
			next.resume();
		}
		else {
			this.active -= 1;
		}
	}
}
