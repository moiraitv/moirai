import { createWriteStream } from 'node:fs';
import {
	lstat,
	mkdir,
	open,
	readFile,
	readdir,
	rename,
	rm,
	stat,
	writeFile,
	type FileHandle,
} from 'node:fs/promises';
import path from 'node:path';
import { finished, pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import type { FastifyBaseLogger } from 'fastify';
import { z } from 'zod';
import {
	FALLBACK_FILLER_MAX_BYTES,
	FALLBACK_FILLER_MIN_DURATION_MILLISECONDS,
	MEDIA_EXTENSIONS,
	type FallbackFillerAsset,
	type FallbackFillerStatus,
} from '@moirai/shared';
import { mediaMimeType } from '../media/media-preview.js';
import type { MediaProbe, MediaProbeResult } from '../media/media-probe.js';
import { currentTimestamp } from '../time.js';

/** Stable channel identifiers accepted as private fallback storage paths. */
const CHANNEL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
/** Fixed managed asset name used by every scope. */
const ASSET_NAME = 'asset';
/** Fixed sidecar name containing operator-facing metadata for one managed asset. */
const METADATA_NAME = 'metadata.json';
/** Directory containing the complete active asset and metadata pair. */
const CURRENT_NAME = 'current';
/** Directory used to stage one complete replacement pair. */
const STAGED_NAME = 'staged';
/** Recoverable prior pair retained only while the active directory changes. */
const PREVIOUS_NAME = 'previous';

/** Persisted facts needed to present and play one validated fallback asset. */
const storedFallbackFillerSchema = z.object({
	version: z.literal(1),
	filename: z.string().min(1).max(180),
	contentType: z.string().min(1).max(120),
	fileSizeBytes: z.number().int().positive().max(FALLBACK_FILLER_MAX_BYTES),
	durationMilliseconds: z.number().int().min(FALLBACK_FILLER_MIN_DURATION_MILLISECONDS),
	resolution: z.object({
		width: z.number().int().positive(),
		height: z.number().int().positive(),
	}).nullable(),
	hasAudio: z.boolean(),
	updatedAt: z.iso.datetime({ offset: true }).nullable(),
});

/** Persisted fallback metadata stored beside its fixed asset slot. */
type StoredFallbackFiller = z.infer<typeof storedFallbackFillerSchema>;

/** Bundled metadata includes the packaged filename used outside managed storage. */
const bundledFallbackFillerSchema = storedFallbackFillerSchema.extend({
	file: z.string().refine((value) => value === path.basename(value)),
});

/** Scope that owns an optional managed fallback override. */
export type FallbackFillerScope
	= | { type: 'global' }
		| { type: 'channel'; channelId: string };

/** Effective local file and playback facts consumed by playout generation. */
export interface ResolvedFallbackFiller {
	source: 'channel' | 'global' | 'bundled';
	path: string;
	durationMilliseconds: number;
	hasAudio: boolean;
}

/** Open effective fallback content returned to an authenticated preview route. */
export interface OpenFallbackFiller {
	asset: FallbackFillerAsset;
	handle: FileHandle;
	size: number;
	mtime: Date;
}

/** File stream augmented by the multipart parser when its byte limit is reached. */
export type LimitedFallbackUpload = Readable & { truncated?: boolean };

/** Coordinate an atomic asset swap with the playout consumers that reference its fixed path. */
export type FallbackFillerReplacement = (
	activate: () => Promise<void>,
) => Promise<void>;

/** One optional override lookup and its safe operator-facing failure. */
interface OverrideLookup {
	stored: StoredFallbackFiller | null;
	path: string | null;
	error: string | null;
	configured: boolean;
}

/** One effective selection carried with the metadata that describes its bytes. */
interface EffectiveFallbackLookup {
	source: ResolvedFallbackFiller['source'];
	stored: StoredFallbackFiller;
	path: string;
}

/** Select a supported content type from ffprobe container metadata. */
function fallbackContentType(result: MediaProbeResult, originalExtension: string): string {
	const container = result.container?.toLowerCase() ?? '';
	if (container.includes('matroska') && container.includes('webm')) {
		return mediaMimeType(originalExtension === '.webm' ? 'asset.webm' : 'asset.mkv');
	}
	if (container.includes('webm')) {
		return mediaMimeType('asset.webm');
	}
	if (container.includes('matroska')) {
		return mediaMimeType('asset.mkv');
	}
	if (container.includes('mpegts')) {
		return mediaMimeType('asset.ts');
	}
	if (container.includes('avi')) {
		return mediaMimeType('asset.avi');
	}
	if (container.includes('mov') || container.includes('mp4')) {
		return mediaMimeType(originalExtension === '.mov' ? 'asset.mov' : 'asset.mp4');
	}
	if (container.includes('mpeg')) {
		return mediaMimeType('asset.mpeg');
	}

	throw new FallbackFillerValidationError('The uploaded video container is not supported');
}

/** Return the measured duration of the only video stream accepted for fallback playback. */
function fallbackVideoDuration(result: MediaProbeResult): number | null {
	const videoStreams = result.streams.filter((stream) => stream.type === 'video');
	if (videoStreams.length !== 1) {
		throw new FallbackFillerValidationError(
			'Fallback filler must contain exactly one video stream',
		);
	}

	return videoStreams[0]!.durationMilliseconds;
}

/** Report a managed fallback upload that cannot safely be used for playback. */
export class FallbackFillerValidationError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = 'FallbackFillerValidationError';
	}
}

/** Report a managed fallback upload that exceeds the bounded storage contract. */
export class FallbackFillerTooLargeError extends FallbackFillerValidationError {
	constructor() {
		super('Fallback filler cannot exceed 512 MiB');
		this.name = 'FallbackFillerTooLargeError';
	}
}

/**
 * Own the bundled fallback and one atomic managed asset slot per global or channel scope. Invalid
 * managed state remains visible to operators while playback safely inherits the next valid source.
 */
export class FallbackFillerStore {
	private bundled: (StoredFallbackFiller & { file: string }) | null = null;
	private readonly invalidScopes = new Set<string>();
	private readonly suppressedScopes = new Set<string>();
	private readonly mutations = new Map<string, Promise<void>>();
	private readonly operations = new Map<string, Promise<void>>();

	constructor(
		private readonly root: string,
		private readonly bundledRoot: string,
		private readonly mediaProbe: MediaProbe,
		private readonly logger: Pick<FastifyBaseLogger, 'warn'>,
	) {}

	/** Load packaged metadata and discard fallback directories whose channels no longer exist. */
	async start(channelIds: Iterable<string>): Promise<void> {
		const bundled = bundledFallbackFillerSchema.parse(
			JSON.parse(await readFile(path.join(this.bundledRoot, 'dead-air.json'), 'utf8')),
		);
		const filePath = path.join(this.bundledRoot, bundled.file);
		const info = await lstat(filePath);
		if (!info.isFile() || info.isSymbolicLink()) {
			throw new Error('Bundled fallback filler does not match its metadata');
		}
		if (info.size !== bundled.fileSizeBytes) {
			throw new Error('Bundled fallback filler does not match its metadata');
		}
		this.bundled = bundled;

		const activeChannelIds = [...channelIds];
		await mkdir(this.root, { recursive: true });
		await this.reconcileChannels(activeChannelIds);
		const scopes: FallbackFillerScope[] = [
			{ type: 'global' },
			...activeChannelIds.map((channelId) => ({ type: 'channel', channelId } as const)),
		];
		await Promise.all(scopes.map((scope) => this.recoverScope(scope)));
		await Promise.all([
			this.validateStoredOverride({ type: 'global' }),
			...activeChannelIds.map((channelId) => this.validateStoredOverride({
				type: 'channel',
				channelId,
			} as const)),
		]);
	}

	/** Return effective and scope-owned fallback metadata for management views. */
	async status(scope: FallbackFillerScope): Promise<FallbackFillerStatus> {
		return this.serialize(this.readScopes(scope), () => this.statusUnlocked(scope));
	}

	/** Build management status while the required fallback scopes are stable. */
	private async statusUnlocked(scope: FallbackFillerScope): Promise<FallbackFillerStatus> {
		const own = await this.override(scope);
		const bundled = this.publicAsset(
			'bundled',
			this.requiredBundled(),
			null,
			'/api/v1/playback/fallback-filler/bundled-preview',
		);
		const global = scope.type === 'channel'
			? await this.override({ type: 'global' })
			: null;
		const inherited = global?.stored && global.path
			? this.publicAsset('global', global.stored)
			: scope.type === 'channel'
				? { ...bundled, previewUrl: '/api/v1/playback/fallback-filler/preview' }
				: bundled;
		const ownAsset = own.stored && own.path
			? this.publicAsset(scope.type, own.stored, scope.type === 'channel' ? scope.channelId : null)
			: null;
		const inheritedError = scope.type === 'channel' && !ownAsset && global?.error
			? 'The global fallback override is unavailable; using the bundled fallback.'
			: null;

		return {
			override: ownAsset,
			overrideConfigured: own.configured,
			effective: ownAsset ?? inherited,
			inherited,
			overrideError: own.error ?? inheritedError,
		};
	}

	/** Resolve the local media path and loop facts used for one channel's uncovered intervals. */
	async resolve(channelId: string): Promise<ResolvedFallbackFiller> {
		const scope: FallbackFillerScope = { type: 'channel', channelId };
		return this.serialize(this.readScopes(scope), async () => {
			const effective = await this.effective(scope);
			return {
				source: effective.source,
				path: effective.path,
				durationMilliseconds: effective.stored.durationMilliseconds,
				hasAudio: effective.stored.hasAudio,
			};
		});
	}

	/** Open the effective asset for a seekable authenticated browser preview. */
	async openEffective(scope: FallbackFillerScope): Promise<OpenFallbackFiller> {
		return this.serialize(this.readScopes(scope), async () => {
			const effective = await this.effective(scope);
			const previewUrl = scope.type === 'channel'
				? `/api/v1/channels/${scope.channelId}/fallback-filler/preview`
				: '/api/v1/playback/fallback-filler/preview';
			return this.openAsset(
				effective.path,
				this.publicAsset(
					effective.source,
					effective.stored,
					effective.source === 'channel' && scope.type === 'channel' ? scope.channelId : null,
					previewUrl,
				),
			);
		});
	}

	/** Open the immutable bundled asset for a staged global-removal preview. */
	async openBundled(): Promise<OpenFallbackFiller> {
		const bundled = this.requiredBundled();
		return this.openAsset(
			path.join(this.bundledRoot, bundled.file),
			this.publicAsset(
				'bundled',
				bundled,
				null,
				'/api/v1/playback/fallback-filler/bundled-preview',
			),
		);
	}

	/** Stream, validate, and atomically activate one complete managed asset pair. */
	async store(
		scope: FallbackFillerScope,
		filename: string,
		upload: LimitedFallbackUpload,
		replace: FallbackFillerReplacement = async (activate) => activate(),
	): Promise<FallbackFillerStatus> {
		this.assertScope(scope);
		const extension = path.extname(filename).toLowerCase();
		if (!(MEDIA_EXTENSIONS as readonly string[]).includes(extension)) {
			upload.resume();
			await finished(upload).catch(() => undefined);
			throw new FallbackFillerValidationError('Choose a supported video file');
		}

		await this.serializeMutation([scope], async () => {
			const directory = this.scopeDirectory(scope);
			await mkdir(directory, { recursive: true });
			const stagedDirectory = this.stagedPath(scope);
			await rm(stagedDirectory, { recursive: true, force: true });
			const temporaryAsset = path.join(stagedDirectory, `.upload${extension}`);
			let activated = false;
			try {
				await mkdir(stagedDirectory, { mode: 0o700 });
				await pipeline(upload, createWriteStream(temporaryAsset, { flags: 'wx', mode: 0o600 }));
				const info = await lstat(temporaryAsset);
				if (upload.truncated || info.size > FALLBACK_FILLER_MAX_BYTES) {
					throw new FallbackFillerTooLargeError();
				}

				const probed = await this.mediaProbe.probe(
					stagedDirectory,
					path.basename(temporaryAsset),
				);
				const durationMilliseconds = fallbackVideoDuration(probed);
				if (durationMilliseconds === null) {
					throw new FallbackFillerValidationError(
						'Fallback filler video stream has no usable measured duration',
					);
				}
				if (durationMilliseconds < FALLBACK_FILLER_MIN_DURATION_MILLISECONDS) {
					throw new FallbackFillerValidationError(
						'Fallback filler must be at least 1 minute long',
					);
				}

				const stored: StoredFallbackFiller = {
					version: 1,
					filename: path.basename(filename).trim().slice(0, 180) || `fallback${extension}`,
					contentType: fallbackContentType(probed, extension),
					fileSizeBytes: info.size,
					durationMilliseconds,
					resolution: probed.resolution,
					hasAudio: probed.streams.some((stream) => stream.type === 'audio'),
					updatedAt: currentTimestamp(),
				};
				await rename(temporaryAsset, path.join(stagedDirectory, ASSET_NAME));
				await writeFile(
					path.join(stagedDirectory, METADATA_NAME),
					`${JSON.stringify(stored, null, 2)}\n`,
					{ mode: 0o600 },
				);
				const activate = async (): Promise<void> => {
					await this.serialize([scope], async () => {
						await this.activate(scope);
						activated = true;
						this.invalidScopes.delete(this.scopeKey(scope));
					});
				};
				await replace(activate);
			}
			finally {
				if (!activated) {
					await rm(stagedDirectory, { recursive: true, force: true });
				}
			}
		});

		return this.status(scope);
	}

	/** Clear only the requested managed override. */
	async remove(
		scope: FallbackFillerScope,
		synchronize: () => Promise<void> = async () => undefined,
	): Promise<FallbackFillerStatus> {
		this.assertScope(scope);
		await this.serializeMutation([scope], async () => {
			const key = this.scopeKey(scope);
			this.suppressedScopes.add(key);
			try {
				await synchronize();
				await this.serialize([scope], async () => {
					await Promise.all([
						rm(this.currentPath(scope), { recursive: true, force: true }),
						rm(this.stagedPath(scope), { recursive: true, force: true }),
						rm(this.previousPath(scope), { recursive: true, force: true }),
					]);
					this.invalidScopes.delete(key);
				});
			}
			finally {
				this.suppressedScopes.delete(key);
			}
		});

		return this.status(scope);
	}

	/** Remove all managed fallback state owned by a deleted channel. */
	async removeChannel(channelId: string): Promise<void> {
		const scope: FallbackFillerScope = { type: 'channel', channelId };
		this.assertScope(scope);
		await this.serializeMutation([scope], () => this.serialize([scope], async () => {
			await rm(this.scopeDirectory(scope), { recursive: true, force: true });
			this.invalidScopes.delete(this.scopeKey(scope));
		}));
	}

	/** Remove managed fallback scopes whose owning channels no longer exist. */
	async reconcileChannels(channelIds: Iterable<string>): Promise<void> {
		const active = new Set(channelIds);
		for (const channelId of active) {
			this.assertScope({ type: 'channel', channelId });
		}

		const channelsRoot = path.join(this.root, 'channels');
		for (const entry of await readdir(channelsRoot, { withFileTypes: true }).catch(() => [])) {
			if (entry.isDirectory() && CHANNEL_ID.test(entry.name) && !active.has(entry.name)) {
				await this.removeChannel(entry.name);
			}
		}
	}

	/** Open one resolved asset and retain its handle for a range-aware response stream. */
	private async openAsset(assetPath: string, asset: FallbackFillerAsset): Promise<OpenFallbackFiller> {
		const handle = await open(assetPath, 'r');
		try {
			const info = await handle.stat();
			if (!info.isFile()) {
				throw new Error('Fallback filler is not a regular file');
			}
			return { asset, handle, size: info.size, mtime: info.mtime };
		}
		catch (error) {
			await handle.close();
			throw error;
		}
	}

	/** Select the first available channel, global, or bundled fallback. */
	private async effective(scope: FallbackFillerScope): Promise<EffectiveFallbackLookup> {
		if (scope.type === 'channel') {
			const channel = await this.override(scope);
			if (channel.stored && channel.path) {
				return { source: 'channel', stored: channel.stored, path: channel.path };
			}
		}

		const global = await this.override({ type: 'global' });
		if (global.stored && global.path) {
			return { source: 'global', stored: global.stored, path: global.path };
		}

		const bundled = this.requiredBundled();
		return {
			source: 'bundled',
			stored: bundled,
			path: path.join(this.bundledRoot, bundled.file),
		};
	}

	/** Read one managed slot and verify that its metadata still describes the fixed asset. */
	private async override(scope: FallbackFillerScope): Promise<OverrideLookup> {
		this.assertScope(scope);
		if (this.suppressedScopes.has(this.scopeKey(scope))) {
			return { stored: null, path: null, error: null, configured: false };
		}
		if (this.invalidScopes.has(this.scopeKey(scope))) {
			return {
				stored: null,
				path: null,
				error: 'The configured fallback override is unavailable; using an inherited fallback.',
				configured: true,
			};
		}
		const assetPath = this.assetPath(scope);
		const metadataPath = this.metadataPath(scope);
		const currentInfo = await lstat(this.currentPath(scope))
			.catch((error: NodeJS.ErrnoException) => {
				if (error.code === 'ENOENT') {
					return null;
				}
				throw error;
			});
		try {
			if (!currentInfo) {
				return { stored: null, path: null, error: null, configured: false };
			}
			if (!currentInfo.isDirectory() || currentInfo.isSymbolicLink()) {
				throw new Error('Managed fallback current state is not a private directory');
			}
			const [assetInfo, metadata] = await Promise.all([
				stat(assetPath).catch((error: NodeJS.ErrnoException) => {
					if (error.code === 'ENOENT') {
						return null;
					}
					throw error;
				}),
				readFile(metadataPath, 'utf8').catch((error: NodeJS.ErrnoException) => {
					if (error.code === 'ENOENT') {
						return null;
					}
					throw error;
				}),
			]);
			if (!assetInfo?.isFile() || metadata === null) {
				throw new Error('Managed fallback state is incomplete');
			}

			const stored = storedFallbackFillerSchema.parse(JSON.parse(metadata));
			if (assetInfo.size !== stored.fileSizeBytes) {
				throw new Error('Managed fallback asset does not match its metadata');
			}
			return { stored, path: assetPath, error: null, configured: true };
		}
		catch (error) {
			this.logger.warn({ error, scope }, 'Managed fallback filler is unavailable');
			return {
				stored: null,
				path: null,
				error: 'The configured fallback override is unavailable; using an inherited fallback.',
				configured: currentInfo !== null,
			};
		}
	}

	/** Probe one persisted slot once at startup before allowing it into generated playout. */
	private async validateStoredOverride(scope: FallbackFillerScope): Promise<void> {
		const lookup = await this.override(scope);
		if (!lookup.stored || !lookup.path) {
			return;
		}

		try {
			const probed = await this.mediaProbe.probe(this.currentPath(scope), ASSET_NAME);
			const durationMilliseconds = fallbackVideoDuration(probed);
			if (
				durationMilliseconds !== lookup.stored.durationMilliseconds
				|| probed.fileSizeBytes !== lookup.stored.fileSizeBytes
				|| probed.streams.some((stream) => stream.type === 'audio') !== lookup.stored.hasAudio
			) {
				throw new Error('Managed fallback probe does not match its metadata');
			}
		}
		catch (error) {
			this.invalidScopes.add(this.scopeKey(scope));
			this.logger.warn({ error, scope }, 'Managed fallback filler failed startup validation');
		}
	}

	/** Convert stored metadata into the authenticated management response. */
	private publicAsset(
		source: FallbackFillerAsset['source'],
		stored: StoredFallbackFiller,
		channelId: string | null = null,
		previewUrlOverride: string | null = null,
	): FallbackFillerAsset {
		const previewUrl = previewUrlOverride ?? (source === 'channel' && channelId
			? `/api/v1/channels/${channelId}/fallback-filler/preview`
			: '/api/v1/playback/fallback-filler/preview');
		return {
			source,
			filename: stored.filename,
			contentType: stored.contentType,
			fileSizeBytes: stored.fileSizeBytes,
			durationMilliseconds: stored.durationMilliseconds,
			resolution: stored.resolution,
			hasAudio: stored.hasAudio,
			updatedAt: stored.updatedAt,
			previewUrl,
		};
	}

	/** Return the verified packaged fallback or fail before unsafe playout generation. */
	private requiredBundled(): StoredFallbackFiller & { file: string } {
		if (!this.bundled) {
			throw new Error('Bundled fallback filler is not initialized');
		}
		return this.bundled;
	}

	/** Return the private directory for one validated override scope. */
	private scopeDirectory(scope: FallbackFillerScope): string {
		this.assertScope(scope);
		return scope.type === 'global'
			? path.join(this.root, 'global')
			: path.join(this.root, 'channels', scope.channelId);
	}

	/** Replace the complete active directory and roll back if its final rename fails. */
	private async activate(scope: FallbackFillerScope): Promise<void> {
		const current = this.currentPath(scope);
		const previous = this.previousPath(scope);
		await rm(previous, { recursive: true, force: true });
		let movedCurrent = false;
		try {
			await rename(current, previous);
			movedCurrent = true;
		}
		catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
				throw error;
			}
		}

		try {
			await rename(this.stagedPath(scope), current);
		}
		catch (error) {
			if (movedCurrent) {
				await rename(previous, current);
			}
			throw error;
		}

		if (movedCurrent) {
			await rm(previous, { recursive: true, force: true }).catch((error) => {
				this.logger.warn({ error, scope }, 'Old fallback filler state could not be removed');
			});
		}
	}

	/** Restore the prior complete pair after an interrupted directory replacement. */
	private async recoverScope(scope: FallbackFillerScope): Promise<void> {
		const current = this.currentPath(scope);
		const currentInfo = await lstat(current).catch((error: NodeJS.ErrnoException) => {
			if (error.code === 'ENOENT') {
				return null;
			}
			throw error;
		});
		if (!currentInfo) {
			await rename(this.previousPath(scope), current).catch((error: NodeJS.ErrnoException) => {
				if (error.code !== 'ENOENT') {
					throw error;
				}
			});
		}

		await rm(this.stagedPath(scope), { recursive: true, force: true });
		if (await lstat(current).catch(() => null)) {
			await rm(this.previousPath(scope), { recursive: true, force: true });
		}
	}

	/** Return the complete active pair for one scope. */
	private currentPath(scope: FallbackFillerScope): string {
		return path.join(this.scopeDirectory(scope), CURRENT_NAME);
	}

	/** Return the private staging directory for one scope. */
	private stagedPath(scope: FallbackFillerScope): string {
		return path.join(this.scopeDirectory(scope), STAGED_NAME);
	}

	/** Return the rollback directory used only during activation. */
	private previousPath(scope: FallbackFillerScope): string {
		return path.join(this.scopeDirectory(scope), PREVIOUS_NAME);
	}

	/** Return the fixed managed asset path for one scope. */
	private assetPath(scope: FallbackFillerScope): string {
		return path.join(this.currentPath(scope), ASSET_NAME);
	}

	/** Return the fixed managed metadata path for one scope. */
	private metadataPath(scope: FallbackFillerScope): string {
		return path.join(this.currentPath(scope), METADATA_NAME);
	}

	/** Return one stable in-memory key for a validated fallback scope. */
	private scopeKey(scope: FallbackFillerScope): string {
		return scope.type === 'global' ? 'global' : `channel:${scope.channelId}`;
	}

	/** Return the scope plus any inherited global state needed for one consistent read. */
	private readScopes(scope: FallbackFillerScope): FallbackFillerScope[] {
		return scope.type === 'channel' ? [{ type: 'global' }, scope] : [scope];
	}

	/** Reject channel identifiers that could escape the private storage root. */
	private assertScope(scope: FallbackFillerScope): void {
		if (scope.type === 'channel' && !CHANNEL_ID.test(scope.channelId)) {
			throw new Error('Invalid channel identity');
		}
	}

	/** Serialize one operation against only the managed scopes whose state it observes or changes. */
	private async serialize<T>(
		scopes: FallbackFillerScope[],
		operation: () => Promise<T>,
	): Promise<T> {
		return this.serializeWith(this.operations, scopes, operation);
	}

	/** Preserve request order for mutations without blocking reads while uploads are staged. */
	private async serializeMutation<T>(
		scopes: FallbackFillerScope[],
		operation: () => Promise<T>,
	): Promise<T> {
		return this.serializeWith(this.mutations, scopes, operation);
	}

	/** Queue one operation in every requested scope of the selected operation map. */
	private async serializeWith<T>(
		operations: Map<string, Promise<void>>,
		scopes: FallbackFillerScope[],
		operation: () => Promise<T>,
	): Promise<T> {
		const keys = [...new Set(scopes.map((scope) => this.scopeKey(scope)))].sort();
		const prior = Promise.all(keys.map((key) => operations.get(key) ?? Promise.resolve()));
		let release: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const tail = prior.then(() => gate);
		for (const key of keys) {
			operations.set(key, tail);
		}

		await prior;
		try {
			return await operation();
		}
		finally {
			release();
			for (const key of keys) {
				if (operations.get(key) === tail) {
					operations.delete(key);
				}
			}
		}
	}
}
