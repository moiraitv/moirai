import { createHash } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import type { Logger } from 'pino';
import { MAX_MEDIA_DURATION_MILLISECONDS } from '@moirai/shared';
import { resourceErrorCode, type ResourcePressureCoordinator } from '../operations/resource-pressure.js';
import { openSourceFile } from './source-file.js';

/** Probe contract version included in cache identities. */
export const MEDIA_PROBE_VERSION = 5;
/** Maximum ffprobe JSON accepted from one media file. */
const MAX_PROBE_OUTPUT_BYTES = 256 * 1024;
/** Maximum stream records retained from an untrusted container. */
const MAX_PROBE_STREAMS = 64;
/** Child descriptor reserved for validated media input without colliding with development IPC. */
const MEDIA_INPUT_DESCRIPTOR = 4;

/** Return whether ffprobe reports the seekable descriptor input protocol required by Moirai. */
function supportsDescriptorInput(output: string): boolean {
	const input = output.match(/(?:^|\n)Input:\s*\n([\s\S]*?)(?:\nOutput:|$)/)?.[1];
	return Boolean(input?.split(/\s+/).includes('fd'));
}

/** Convert process-launch failures into safe media-probe diagnostics. */
function processLaunchError(error: unknown): MediaProbeError {
	const resourceCode = resourceErrorCode(error);
	const code: MediaProbeFailureCode = resourceCode
		? 'resource-exhausted'
		: (error as NodeJS.ErrnoException).code === 'ENOENT'
			? 'executable-unavailable'
			: 'probe-failed';
	return new MediaProbeError(
		code,
		resourceCode
			? 'System resource capacity prevented media inspection'
			: 'ffprobe could not be started',
		{ cause: error },
	);
}

/** Stable failure categories stored without exposing process or filesystem details. */
export type MediaProbeFailureCode
	= | 'cancelled'
		| 'executable-unavailable'
		| 'invalid-output'
		| 'missing-duration'
		| 'missing-video'
		| 'probe-failed'
		| 'resource-exhausted'
		| 'timed-out';

/** One video or audio stream observed directly in a media container. */
export interface ProbedMediaStream {
	index: number;
	type: 'video' | 'audio' | 'subtitle';
	codec: string | null;
	durationMilliseconds: number | null;
	width: number | null;
	height: number | null;
	channels?: number | null;
	language: string | null;
	title: string | null;
	isDefault: boolean;
	isForced: boolean;
	isHearingImpaired: boolean;
	isCommentary: boolean;
}

/** Playback-critical facts measured directly from a media file. */
export interface MediaProbeResult {
	durationMilliseconds: number;
	fileSizeBytes: number;
	container: string | null;
	streams: ProbedMediaStream[];
	resolution: { width: number; height: number } | null;
	tags: Record<string, string>;
}

/** Safe media-probe error suitable for scan diagnostics and persistence. */
export class MediaProbeError extends Error {
	constructor(public readonly code: MediaProbeFailureCode, message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = 'MediaProbeError';
	}
}

/** Health state exposed through the readiness service. */
export interface MediaProbeHealth {
	status: 'starting' | 'ready' | 'degraded' | 'stopping';
	detail?: string;
}

/** Minimal ffprobe JSON shape consumed by the bounded parser. */
interface ProbeDocument {
	format?: {
		duration?: string | number;
		format_name?: string;
		tags?: Record<string, unknown>;
	};
	streams?: Array<{
		index?: number;
		codec_type?: string;
		codec_name?: string;
		width?: number;
		height?: number;
		channels?: number;
		duration?: string | number;
		tags?: Record<string, unknown>;
		disposition?: Record<string, unknown>;
	}>;
}

/** Convert one bounded ffprobe tag into safe catalog text. */
function probeTag(value: unknown): string | null {
	return typeof value === 'string' && value.trim()
		? value.trim().slice(0, 512)
		: null;
}

/** Read a case-insensitive ffprobe tag name. */
function tagged(tags: Record<string, unknown> | undefined, name: string): string | null {
	const entry = Object.entries(tags ?? {}).find(([key]) => key.toLowerCase() === name);
	return probeTag(entry?.[1]);
}

/** Interpret an ffprobe disposition value as a boolean flag. */
function disposition(value: unknown): boolean {
	return value === 1 || value === '1' || value === true;
}

/** Produce a stable cache identity from the opened media file itself. */
export function mediaProbeFingerprint(info: {
	dev: number | bigint;
	ino: number | bigint;
	size: number | bigint;
	mtimeMs: number | bigint;
}): string {
	return createHash('sha256')
		.update(
			[
				MEDIA_PROBE_VERSION,
				String(info.dev),
				String(info.ino),
				String(info.size),
				String(info.mtimeMs),
			].join(':'),
		)
		.digest('hex');
}

/** Parse one positive duration value expressed in seconds. */
function durationMilliseconds(value: unknown): number | null {
	const seconds = typeof value === 'number' ? value : Number(value);
	if (!Number.isFinite(seconds) || seconds <= 0) {
		return null;
	}

	const milliseconds = Math.round(seconds * 1_000);
	return Number.isSafeInteger(milliseconds)
		&& milliseconds > 0
		&& milliseconds <= MAX_MEDIA_DURATION_MILLISECONDS
		? milliseconds
		: null;
}

/** Parse an ffprobe stream duration tag expressed as hours, minutes, and fractional seconds. */
function taggedDurationMilliseconds(tags: Record<string, unknown> | undefined): number | null {
	const value = tagged(tags, 'duration');
	const match = /^(\d+):([0-5]\d):([0-5]\d(?:\.\d+)?)$/u.exec(value ?? '');
	if (!match) {
		return null;
	}

	const seconds = Number(match[1]) * 3_600 + Number(match[2]) * 60 + Number(match[3]);
	return durationMilliseconds(seconds);
}

/** Prefer a native stream duration while accepting Matroska's equivalent duration tag. */
function streamDurationMilliseconds(
	stream: NonNullable<ProbeDocument['streams']>[number],
): number | null {
	return durationMilliseconds(stream.duration) ?? taggedDurationMilliseconds(stream.tags);
}

/** Normalize a positive integer stream dimension. */
function dimension(value: unknown): number | null {
	return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

/** Validate bounded ffprobe output and derive playback duration solely from video tracks. */
export function parseMediaProbeOutput(output: string, fileSizeBytes: number): MediaProbeResult {
	let document: ProbeDocument;
	try {
		document = JSON.parse(output) as ProbeDocument;
	}
	catch {
		throw new MediaProbeError('invalid-output', 'ffprobe returned invalid media information');
	}
	const rawStreams = Array.isArray(document.streams)
		? document.streams.slice(0, MAX_PROBE_STREAMS)
		: [];
	const streams = rawStreams.flatMap<ProbedMediaStream>((stream, fallbackIndex) => {
		if (!['video', 'audio', 'subtitle'].includes(stream.codec_type ?? '')) {
			return [];
		}

		return [{
			index: Number.isInteger(stream.index) && stream.index! >= 0 ? stream.index! : fallbackIndex,
			type: stream.codec_type as ProbedMediaStream['type'],
			codec: typeof stream.codec_name === 'string' ? stream.codec_name.slice(0, 64) : null,
			durationMilliseconds: streamDurationMilliseconds(stream),
			width: stream.codec_type === 'video' ? dimension(stream.width) : null,
			height: stream.codec_type === 'video' ? dimension(stream.height) : null,
			channels: stream.codec_type === 'audio' ? dimension(stream.channels) : null,
			language: tagged(stream.tags, 'language')?.toLocaleLowerCase('en-US') ?? null,
			title: tagged(stream.tags, 'title'),
			isDefault: disposition(stream.disposition?.default),
			isForced: disposition(stream.disposition?.forced),
			isHearingImpaired: disposition(stream.disposition?.hearing_impaired),
			isCommentary: disposition(stream.disposition?.comment),
		}];
	});
	const videoStreams = streams.filter((stream) => stream.type === 'video');
	if (videoStreams.length === 0) {
		throw new MediaProbeError('missing-video', 'Media file has no usable video stream');
	}

	const measuredDuration = videoStreams.reduce<number | null>((longest, stream) => {
		const current = stream.durationMilliseconds;
		return current !== null && (longest === null || current > longest) ? current : longest;
	}, null);
	if (measuredDuration === null) {
		throw new MediaProbeError('missing-duration', 'Media file has no usable measured video duration');
	}

	const primaryVideo = videoStreams.find((stream) => stream.width && stream.height);
	return {
		durationMilliseconds: measuredDuration,
		fileSizeBytes,
		container: typeof document.format?.format_name === 'string'
			? document.format.format_name.slice(0, 128)
			: null,
		streams,
		resolution: primaryVideo?.width && primaryVideo.height
			? { width: primaryVideo.width, height: primaryVideo.height }
			: null,
		tags: Object.fromEntries(
			['title', 'artist', 'album_artist', 'album', 'track', 'disc', 'date', 'year', 'genre']
				.flatMap((name) => {
					const value = tagged(document.format?.tags, name);
					return value ? [[name, value]] : [];
				}),
		),
	};
}

/**
 * Inspect media through a bounded set of ffprobe child processes. The service verifies descriptor-safe
 * executable support, enforces concurrency and timeouts, normalizes playback facts, and exposes probe
 * availability through readiness state.
 */
export class MediaProbe {
	private active = 0;
	private readonly waiters: Array<() => void> = [];
	private readonly children = new Set<ChildProcess>();
	private state: MediaProbeHealth = { status: 'starting' };
	private closing = false;

	constructor(
		private readonly executable: string,
		private readonly concurrency: number,
		private readonly timeoutMs: number,
		private readonly logger?: Pick<Logger, 'warn'>,
		private readonly resourcePressure?: ResourcePressureCoordinator,
	) {}

	/** Maximum number of media files the scanner should inspect in parallel. */
	get concurrencyLimit(): number {
		return this.concurrency;
	}

	/** Check whether the configured ffprobe executable can start. */
	async start(): Promise<void> {
		try {
			await this.run(['-version']);
			const protocols = await this.run(['-hide_banner', '-protocols']);
			if (!supportsDescriptorInput(protocols)) {
				throw new MediaProbeError(
					'executable-unavailable',
					'ffprobe does not support seekable descriptor input',
				);
			}

			this.state = { status: 'ready' };
		}
		catch (error) {
			this.state = {
				status: 'degraded',
				detail: error instanceof MediaProbeError
					? `${error.message}; new or changed media cannot be scheduled`
					: 'ffprobe is unavailable; new or changed media cannot be scheduled',
			};
			this.logger?.warn({ error }, 'ffprobe availability check failed');
		}
	}

	/** Return current probe-service readiness without starting a subprocess. */
	health(): MediaProbeHealth {
		return this.closing ? { status: 'stopping' } : this.state;
	}

	/** Inspect one validated regular media file through an inherited descriptor. */
	async probe(scanRoot: string, file: string, signal?: AbortSignal): Promise<MediaProbeResult> {
		if (this.state.status !== 'ready') {
			throw new MediaProbeError('executable-unavailable', 'ffprobe is unavailable');
		}

		await this.acquire(signal);
		try {
			signal?.throwIfAborted();
			const source = await openSourceFile(scanRoot, file);
			try {
				const output = await this.run(
					[
						'-v',
						'error',
						'-show_entries',
						'format=duration,format_name:format_tags=title,artist,album_artist,album,track,disc,date,year,genre:stream=index,codec_type,codec_name,width,height,duration:stream_tags=language,title,DURATION:stream_disposition=default,forced,hearing_impaired,comment',
						'-of',
						'json',
						'-fd',
						String(MEDIA_INPUT_DESCRIPTOR),
						'fd:',
					],
					signal,
					source.handle.fd,
				);
				const result = parseMediaProbeOutput(output, source.stat.size);
				this.state = { status: 'ready' };
				return result;
			}
			catch (error) {
				if (
					error instanceof MediaProbeError
					&& ['resource-exhausted', 'executable-unavailable'].includes(error.code)
				) {
					this.state = {
						status: 'degraded',
						detail: `${error.message}; new or changed media cannot be scheduled`,
					};
				}
				throw error;
			}
			finally {
				await source.handle.close();
			}
		}
		finally {
			this.release();
		}
	}

	/** Stop accepting work and terminate every active ffprobe process. */
	async close(): Promise<void> {
		this.closing = true;
		this.state = { status: 'stopping' };
		for (const child of this.children) {
			child.kill('SIGKILL');
		}
		this.waiters.splice(0).forEach((resume) => resume());
	}

	/** Acquire one bounded probe slot with cancellation while queued. */
	private async acquire(signal?: AbortSignal): Promise<void> {
		if (this.closing) {
			throw new MediaProbeError('cancelled', 'Media probing has stopped');
		}

		if (this.active < this.concurrency) {
			this.active += 1;
			return;
		}

		await new Promise<void>((resolve, reject) => {
			const resume = (): void => {
				signal?.removeEventListener('abort', cancel);
				if (this.closing || signal?.aborted) {
					reject(new MediaProbeError('cancelled', 'Media probe was cancelled'));
					return;
				}

				this.active += 1;
				resolve();
			};
			const cancel = (): void => {
				const index = this.waiters.indexOf(resume);
				if (index >= 0) {
					this.waiters.splice(index, 1);
				}
				reject(new MediaProbeError('cancelled', 'Media probe was cancelled'));
			};
			this.waiters.push(resume);
			signal?.addEventListener('abort', cancel, { once: true });
		});
	}

	/** Release one probe slot and resume the oldest queued operation. */
	private release(): void {
		this.active = Math.max(0, this.active - 1);
		this.waiters.shift()?.();
	}

	/** Run one bounded ffprobe command and return its standard output. */
	private run(args: string[], signal?: AbortSignal, inheritedFd?: number): Promise<string> {
		const operation = () => this.runOnce(args, signal, inheritedFd);
		return this.resourcePressure
			? this.resourcePressure.runEssential('ffprobe process launch', operation)
			: operation();
	}

	/** Start one bounded ffprobe child without applying resource-pressure retries. */
	private runOnce(args: string[], signal?: AbortSignal, inheritedFd?: number): Promise<string> {
		return new Promise((resolve, reject) => {
			// Refuse new child processes after shutdown or caller cancellation.
			if (this.closing || signal?.aborted) {
				reject(new MediaProbeError('cancelled', 'Media probe was cancelled'));
				return;
			}

			const stdio: ['ignore', 'pipe', 'pipe', 'ignore', number | 'ignore'] = [
				'ignore',
				'pipe',
				'pipe',
				'ignore',
				inheritedFd ?? 'ignore',
			];
			let child: ChildProcess;
			try {
				child = spawn(this.executable, args, { stdio });
			}
			catch (error) {
				reject(processLaunchError(error));
				return;
			}
			this.children.add(child);

			// Centralize completion so every path releases timers, listeners, and ownership.
			let stdout = Buffer.alloc(0);
			let stderr = Buffer.alloc(0);
			let settled = false;
			const finish = (error?: MediaProbeError): void => {
				if (settled) {
					return;
				}

				settled = true;
				clearTimeout(timeout);
				signal?.removeEventListener('abort', cancel);
				this.children.delete(child);
				if (error) {
					reject(error);
				}
				else {
					resolve(stdout.toString('utf8'));
				}
			};
			const stop = (error: MediaProbeError): void => {
				child.kill('SIGTERM');
				const force = setTimeout(() => child.kill('SIGKILL'), 1_000);
				force.unref();
				finish(error);
			};
			const cancel = (): void => stop(new MediaProbeError('cancelled', 'Media probe was cancelled'));
			const timeout = setTimeout(
				() => stop(new MediaProbeError('timed-out', 'Media probe exceeded its time limit')),
				this.timeoutMs,
			);
			timeout.unref();

			// Bound both output streams and translate child lifecycle events into probe errors.
			child.stdout!.on('data', (chunk: Buffer) => {
				stdout = Buffer.concat([stdout, chunk]);
				if (stdout.length > MAX_PROBE_OUTPUT_BYTES) {
					stop(new MediaProbeError('invalid-output', 'ffprobe output exceeded its limit'));
				}
			});
			child.stderr!.on('data', (chunk: Buffer) => {
				if (stderr.length < MAX_PROBE_OUTPUT_BYTES) {
					stderr = Buffer.concat([stderr, chunk]).subarray(0, MAX_PROBE_OUTPUT_BYTES);
				}
			});
			child.once('error', (error) => {
				finish(processLaunchError(error));
			});
			child.once('close', (code) => {
				finish(
					code === 0
						? undefined
						: new MediaProbeError('probe-failed', 'ffprobe could not read the media file'),
				);
			});
			signal?.addEventListener('abort', cancel, { once: true });
		});
	}
}
