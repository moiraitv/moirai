import { createHash, randomUUID } from 'node:crypto';
import { mkdir, opendir, rename, rm, stat, unlink, utimes } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import type { OpenedSourceFile } from '../media/source-file.js';

export { artworkMimeType } from './artwork-formats.js';

/** Catalog owner and source version used to address cached artwork. */
export interface ArtworkCacheOwner {
	libraryId: string;
	kind: 'items' | 'groups';
	id: string;
	relativePath: string;
	cacheVersion: string;
	role?: 'poster' | 'landscape' | 'fanart';
}

/** Logical UI size generated from source artwork. */
export type ArtworkVariant = 'thumb' | 'card' | 'detail' | 'compat';
/** Device pixel density supported by generated UI artwork. */
export type ArtworkDensity = 1 | 2 | 3;
/** Catalog entity kinds that can own artwork. */
export type ArtworkOwnerKind = ArtworkCacheOwner['kind'];

/** Logical artwork sizes and their maximum width at each pixel density. */
const VARIANT_WIDTHS: Record<ArtworkVariant, number> = {
	thumb: 64,
	card: 240,
	detail: 400,
	compat: 400,
};

/** Size and last-access metadata tracked for LRU eviction. */
interface CacheFile {
	size: number;
	accessedAt: number;
}

/**
 * Provide a persistent, bounded cache of browser-ready artwork variants. The cache coalesces and
 * limits transforms, manages capacity and stale versions, and serves hits without reopening the media
 * source.
 */
export class ArtworkCache {
	private readonly files = new Map<string, CacheFile>();
	private readonly writes = new Map<string, Promise<string | null>>();
	private initialization: Promise<void> | null = null;
	private capacityQueue: Promise<void> = Promise.resolve();
	private cachedBytes = 0;
	private reservedBytes = 0;
	private activeTransforms = 0;
	private readonly transformWaiters: Array<() => void> = [];
	private transformsPaused = false;

	constructor(
		private readonly root: string,
		private readonly maxBytes: number,
		private readonly maxEntryBytes: number,
		private readonly transformConcurrency = 4,
	) {}

	/** Return the maximum source bytes accepted for one artwork transformation. */
	get maximumSourceBytes(): number {
		return this.maxEntryBytes;
	}

	/** Resolve a role-specific cache path while preserving legacy primary-artwork paths. */
	pathFor(
		owner: ArtworkCacheOwner,
		variant: ArtworkVariant = 'card',
		density: ArtworkDensity = 1,
	): string {
		const version = createHash('sha256').update(owner.cacheVersion).digest('hex');
		return path.join(
			this.root,
			owner.libraryId,
			owner.kind,
			owner.id,
			version,
			`${owner.role ? `${owner.role}-` : ''}${variant}@${density}x.jpg`,
		);
	}

	/** Return a cached artwork variant, generating it when needed. */
	async get(
		owner: ArtworkCacheOwner,
		variant: ArtworkVariant = 'card',
		density: ArtworkDensity = 1,
	): Promise<string | null> {
		const cachedPath = this.pathFor(owner, variant, density);
		try {
			const info = await stat(cachedPath);
			if (!info.isFile()) {
				return null;
			}

			this.touch(cachedPath, info.size, info.mtime);
			return cachedPath;
		}
		catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
				this.forget(cachedPath);
			}
			return null;
		}
	}

	/** Return the newest older source version while the current variant fills. */
	async getStale(
		owner: ArtworkCacheOwner,
		variant: ArtworkVariant = 'card',
		density: ArtworkDensity = 1,
	): Promise<string | null> {
		await this.ensureInitialized();
		const current = this.pathFor(owner, variant, density);
		const ownerDirectory = `${path.dirname(path.dirname(current))}${path.sep}`;
		const filename = path.basename(current);
		const candidates = [...this.files.entries()]
			.filter(
				([cachedPath]) =>
					cachedPath.startsWith(ownerDirectory)
					&& cachedPath !== current
					&& path.basename(cachedPath) === filename,
			)
			.sort(([, left], [, right]) => right.accessedAt - left.accessedAt);
		for (const [cachedPath] of candidates) {
			try {
				const info = await stat(cachedPath);
				if (!info.isFile()) {
					continue;
				}

				this.touch(cachedPath, info.size, info.mtime);
				return cachedPath;
			}
			catch (error) {
				if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
					this.forget(cachedPath);
				}
			}
		}
		return null;
	}

	/** Persist one validated asset using an atomic replacement. */
	async store(
		owner: ArtworkCacheOwner,
		sourceFile: OpenedSourceFile,
		variant: ArtworkVariant = 'card',
		density: ArtworkDensity = 1,
	): Promise<string | null> {
		const destination = this.pathFor(owner, variant, density);
		const existingWrite = this.writes.get(destination);
		if (existingWrite) {
			return existingWrite;
		}

		const operation = this.storeOnce(owner, sourceFile, variant, density).finally(() =>
			this.writes.delete(destination));
		this.writes.set(destination, operation);
		return operation;
	}

	/** Remove owner from the artwork cache workflow. */
	async purgeOwner(libraryId: string, kind: ArtworkCacheOwner['kind'], id: string): Promise<void> {
		const directory = path.join(this.root, libraryId, kind, id);
		await rm(directory, { recursive: true, force: true });
		this.forgetPrefix(`${directory}${path.sep}`);
	}

	/** Remove library from the artwork cache workflow. */
	async purgeLibrary(libraryId: string): Promise<void> {
		const directory = path.join(this.root, libraryId);
		await rm(directory, { recursive: true, force: true });
		this.forgetPrefix(`${directory}${path.sep}`);
	}

	/** Pause new artwork transforms while allowing active work to release its resources. */
	pauseTransforms(): void {
		this.transformsPaused = true;
	}

	/** Resume queued artwork transforms after resource pressure clears. */
	resumeTransforms(): void {
		this.transformsPaused = false;
		this.resumeTransformWaiters();
	}

	/** Reconcile owner directories in bounded batches without loading the entire catalog. */
	async pruneOrphans(
		existingIds: (
			libraryId: string,
			kind: ArtworkOwnerKind,
			ids: string[],
		) => Promise<Set<string>>,
	): Promise<void> {
		let libraries;
		try {
			libraries = await opendir(this.root);
		}
		catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
				return;
			}

			throw error;
		}
		for await (const library of libraries) {
			if (!library.isDirectory()) {
				continue;
			}

			for (const kind of ['items', 'groups'] as const) {
				let owners;
				try {
					owners = await opendir(path.join(this.root, library.name, kind));
				}
				catch (error) {
					if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
						continue;
					}

					throw error;
				}
				let batch: string[] = [];
				const reconcile = async (): Promise<void> => {
					if (batch.length === 0) {
						return;
					}

					const ids = batch;
					batch = [];
					const retained = await existingIds(library.name, kind, ids);
					await Promise.all(
						ids
							.filter((id) => !retained.has(id))
							.map((id) => this.purgeOwner(library.name, kind, id)),
					);
				};
				for await (const owner of owners) {
					if (!owner.isDirectory()) {
						continue;
					}

					batch.push(owner.name);
					if (batch.length >= 200) {
						await reconcile();
					}
				}
				await reconcile();
			}
		}
	}

	/** Coalesce concurrent cache fills for the same artwork variant. */
	private async storeOnce(
		owner: ArtworkCacheOwner,
		sourceFile: OpenedSourceFile,
		variant: ArtworkVariant,
		density: ArtworkDensity,
	): Promise<string | null> {
		const hit = await this.get(owner, variant, density);
		if (hit) {
			return hit;
		}

		const source = sourceFile.stat;
		if (!source.isFile() || source.size > this.maxEntryBytes) {
			return null;
		}
		// Index before creating the temporary output so initialization cannot treat this live write
		// as an abandoned file and remove it.
		await this.ensureInitialized();
		const destination = this.pathFor(owner, variant, density);
		const temporary = `${destination}.${randomUUID()}.tmp`;
		let transformedSize = 0;
		let reserved = false;
		try {
			await mkdir(path.dirname(destination), { recursive: true });
			await this.withTransformPermit(async () => {
				const width = Math.min(VARIANT_WIDTHS[variant] * density, 1_200);
				const content = await sourceFile.handle.readFile();
				await sharp(content, { limitInputPixels: 64_000_000, pages: 1 })
					.rotate()
					.flatten({ background: '#08131e' })
					.resize({ width, withoutEnlargement: true })
					.jpeg({ quality: 82, mozjpeg: true })
					.toFile(temporary);
			});
			transformedSize = (await stat(temporary)).size;
			if (transformedSize > this.maxEntryBytes) {
				await unlink(temporary).catch(() => undefined);
				return null;
			}

			reserved = await this.reserve(transformedSize);
			if (!reserved) {
				await unlink(temporary).catch(() => undefined);
				return null;
			}

			await rename(temporary, destination);
			await utimes(destination, new Date(), source.mtime);
			this.cachedBytes += transformedSize;
			this.files.set(destination, { size: transformedSize, accessedAt: Date.now() });
			await this.purgeOlderVariant(owner, destination);
			return destination;
		}
		catch (error) {
			await unlink(temporary).catch(() => undefined);
			throw error;
		}
		finally {
			if (reserved) {
				this.reservedBytes = Math.max(0, this.reservedBytes - transformedSize);
			}
		}
	}

	/** Reserve cache capacity before accepting a new artwork file. */
	private async reserve(bytes: number): Promise<boolean> {
		let reserved = false;
		const operation = this.capacityQueue.then(async () => {
			reserved = await this.reserveExclusive(bytes);
		});
		this.capacityQueue = operation.catch(() => undefined);
		await operation;
		return reserved;
	}

	/** Reserve cache capacity while holding the cache mutation lock. */
	private async reserveExclusive(bytes: number): Promise<boolean> {
		await this.ensureInitialized();
		if (this.cachedBytes + this.reservedBytes + bytes > this.maxBytes) {
			const oldest = [...this.files.entries()].sort(
				([, left], [, right]) => left.accessedAt - right.accessedAt,
			);
			for (const [cachedPath, cached] of oldest) {
				if (this.cachedBytes + this.reservedBytes + bytes <= this.maxBytes) {
					break;
				}

				try {
					await unlink(cachedPath);
					this.files.delete(cachedPath);
					this.cachedBytes -= cached.size;
				}
				catch (error) {
					// A manual purge may have already removed this cache entry.
					if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
						this.forget(cachedPath);
					}
				}
			}
		}
		if (this.cachedBytes + this.reservedBytes + bytes > this.maxBytes) {
			return false;
		}

		this.reservedBytes += bytes;
		return true;
	}

	/** Load the cache inventory once before performing maintenance. */
	private async ensureInitialized(): Promise<void> {
		this.initialization ??= this.indexDirectory(this.root);
		await this.initialization;
	}

	/** Index cache files already present on disk. */
	private async indexDirectory(directory: string): Promise<void> {
		try {
			const entries = await opendir(directory);
			for await (const entry of entries) {
				const absolute = path.join(directory, entry.name);
				if (entry.isDirectory()) {
					await this.indexDirectory(absolute);
				}
				else if (entry.isFile() && !entry.name.endsWith('.tmp')) {
					const info = await stat(absolute);
					const previous = this.files.get(absolute);
					if (previous) {
						this.cachedBytes -= previous.size;
					}
					this.files.set(absolute, { size: info.size, accessedAt: info.atimeMs });
					this.cachedBytes += info.size;
				}
				else if (entry.isFile()) {
					await unlink(absolute).catch(() => undefined);
				}
			}
		}
		catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
				throw error;
			}
		}
	}

	/** Remove a cached file from the in-memory size index. */
	private forget(cachedPath: string): void {
		const cached = this.files.get(cachedPath);
		if (!cached) {
			return;
		}

		this.files.delete(cachedPath);
		this.cachedBytes = Math.max(0, this.cachedBytes - cached.size);
	}

	/** Remove prefix from the artwork cache workflow. */
	private forgetPrefix(prefix: string): void {
		for (const cachedPath of [...this.files.keys()]) {
			if (cachedPath.startsWith(prefix)) {
				this.forget(cachedPath);
			}
		}
	}

	/** Record recent cache access without blocking the response. */
	private touch(cachedPath: string, size: number, modifiedAt: Date): void {
		const accessedAt = Date.now();
		const previous = this.files.get(cachedPath);
		if (previous) {
			this.cachedBytes += size - previous.size;
		}
		else {
			this.cachedBytes += size;
		}
		this.files.set(cachedPath, { size, accessedAt });
		void utimes(cachedPath, new Date(accessedAt), modifiedAt).catch(() => undefined);
	}

	/** Remove older variant from the artwork cache workflow. */
	private async purgeOlderVariant(owner: ArtworkCacheOwner, currentPath: string): Promise<void> {
		const directory = `${path.dirname(path.dirname(currentPath))}${path.sep}`;
		const filename = path.basename(currentPath);
		const obsolete = [...this.files.keys()].filter(
			(cachedPath) =>
				cachedPath.startsWith(directory)
				&& cachedPath !== currentPath
				&& path.basename(cachedPath) === filename,
		);
		for (const cachedPath of obsolete) {
			try {
				await unlink(cachedPath);
				this.forget(cachedPath);
			}
			catch (error) {
				if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
					this.forget(cachedPath);
				}
			}
		}
	}

	/** Run one artwork transform under the global concurrency limit. */
	private async withTransformPermit<T>(operation: () => Promise<T>): Promise<T> {
		if (this.transformsPaused || this.activeTransforms >= this.transformConcurrency) {
			await new Promise<void>((resolve) => this.transformWaiters.push(resolve));
		}
		this.activeTransforms += 1;
		try {
			return await operation();
		}
		finally {
			this.activeTransforms -= 1;
			this.resumeTransformWaiters();
		}
	}

	/** Resume as many queued transforms as current capacity permits. */
	private resumeTransformWaiters(): void {
		if (this.transformsPaused) {
			return;
		}

		const capacity = Math.max(0, this.transformConcurrency - this.activeTransforms);
		this.transformWaiters.splice(0, capacity).forEach((resume) => resume());
	}
}
