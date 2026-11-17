import { execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import type { Channel, MediaSubtitleTrack } from '@moirai/shared';
import type { EtvSubtitleSelection } from '@moirai/ersatztv-contract';
import { mediaStreamUrl, signMediaStream } from '../media-servers/stream-url.js';
import type { RemoteMediaPublishOptions } from './playout-output.js';
import type { SubtitleSnapshotStore } from './subtitle-snapshots.js';

/** Total extraction budget for one background file, shared by its fallback subtitle candidates. */
export const REMOTE_SUBTITLE_EXTRACTION_TIMEOUT_MS = 120_000;

/** Execute FFmpeg without a shell, retaining the child for live-priority cancellation. */
const execute = promisify(execFile);

/** A cache miss deferred until a background pass can prepare the asset. */
export class RemoteSubtitleDeferredError extends Error {
	constructor() {
		super('Remote text subtitles are not ready; playback continues while background preparation is pending');
	}
}

/**
 * Cache extracted remote text subtitles without putting remote reads on the live tune path.
 * Each channel can preempt its background child when promoted for a viewer. Shutdown prevents
 * new extractions and kills active children; callers await preparation before collecting files.
 */
export class RemoteSubtitleAssets {
	private readonly active = new Map<string, ChildProcess>();
	private closed = false;

	constructor(private readonly snapshots: SubtitleSnapshotStore, private readonly remoteMedia?: RemoteMediaPublishOptions) {}

	/** Preempt unpublished optional work before a viewer waits on the shared channel pass. */
	promote(channelId: string): void {
		this.active.get(channelId)?.kill('SIGKILL');
	}

	/** Prevent new work and stop children before the synchronizer waits for preparation cleanup. */
	close(): void {
		this.closed = true;
		for (const child of this.active.values()) {
			child.kill('SIGKILL');
		}
	}

	/** Reuse a complete snapshot, or claim one explicitly admitted background extraction. */
	async prepare(
		channel: Channel,
		track: MediaSubtitleTrack,
		remote: { mediaServerId: string; partId: string },
		playbackPath: string,
		sourceVersion: string,
		remainingMilliseconds: () => number,
	): Promise<EtvSubtitleSelection> {
		const key = JSON.stringify({ path: playbackPath, modified: sourceVersion, stream: track.streamIndex });
		const file = await this.snapshots.asset(channel.id, key, '.ass', async (destination) => {
			const timeout = this.closed ? 0 : Math.min(REMOTE_SUBTITLE_EXTRACTION_TIMEOUT_MS, remainingMilliseconds());
			if (timeout <= 0) {
				throw new RemoteSubtitleDeferredError();
			}
			const remoteMedia = this.remoteMedia;
			if (!remoteMedia?.origin) {
				throw new Error('Remote subtitle extraction requires a signed playback address');
			}

			const expiresAt = Date.now() + timeout;
			const signature = signMediaStream(remoteMedia.secret, expiresAt, remote.mediaServerId, remote.partId);
			const url = mediaStreamUrl(remoteMedia.origin, remote.mediaServerId, remote.partId, expiresAt, signature);
			const operation = execute(channel.ffmpegPath ?? 'ffmpeg', [
				'-nostdin', '-v', 'error', '-y', '-i', url, '-map', `0:${track.streamIndex}`,
				'-c:s', 'ass', '-f', 'ass', destination,
			], { timeout, maxBuffer: 1_048_576 });
			this.active.set(channel.id, operation.child);
			try {
				await operation;
			}
			catch {
				if (this.closed || operation.child.signalCode === 'SIGKILL') {
					throw new RemoteSubtitleDeferredError();
				}
				throw new Error('Unable to extract the selected remote subtitle');
			}
			finally {
				this.active.delete(channel.id);
			}
		});
		return { path: file };
	}
}
