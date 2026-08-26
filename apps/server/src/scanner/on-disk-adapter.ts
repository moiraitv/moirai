import { stat } from 'node:fs/promises';
import {
	onDiskSourceConfigSchema,
	type Library,
} from '@moirai/shared';
import type { MediaProbe } from '../media/media-probe.js';
import type {
	LibrarySourceAdapter,
	ScanContext,
	ScanDiscovery,
	SourceWatcher,
	SourceWatcherCallbacks,
} from './contracts.js';
import { InvalidLibrarySourceConfigurationError } from './contracts.js';
import { discoverOnDisk } from './on-disk.js';
import { createSourceWatcher } from './source-watcher.js';

/**
 * Expose filesystem discovery and watching through the provider-neutral source adapter contract.
 * This adapter validates on-disk configuration, classifies path changes, and delegates bounded media
 * probing without making the scanner manager depend on filesystem details.
 */
export class OnDiskSourceAdapter implements LibrarySourceAdapter {
	readonly sourceType = 'on-disk';
	readonly usesMediaProbeCache = true;

	constructor(private readonly mediaProbe?: MediaProbe) {}

	/** Validate a readable directory without retaining filesystem resources. */
	async validateConfig(config: unknown): Promise<void> {
		try {
			const parsed = onDiskSourceConfigSchema.parse(config);
			const root = await stat(parsed.scanRoot);
			if (!root.isDirectory()) {
				throw new Error('not a directory');
			}
		}
		catch {
			throw new InvalidLibrarySourceConfigurationError('scanRoot must be a readable directory');
		}
	}

	/** Distinguish source replacement from playback-path-only reindexing. */
	configurationImpact(previous: unknown, next: unknown): 'none' | 'index' | 'identity' {
		const prior = onDiskSourceConfigSchema.parse(previous);
		const current = onDiskSourceConfigSchema.parse(next);
		if (prior.scanRoot !== current.scanRoot) {
			return 'identity';
		}

		return prior.playbackRoot !== current.playbackRoot ? 'index' : 'none';
	}

	/** Discover an on-disk library with optional bounded technical probing. */
	async discover(library: Library, context: ScanContext): Promise<ScanDiscovery> {
		return discoverOnDisk(library, {
			signal: context.signal,
			probeCache: context.probeCache,
			discoveryConcurrency: this.mediaProbe?.concurrencyLimit ?? 1,
			onProgress: context.onProgress,
			...(this.mediaProbe
				? {
					probeMedia: (scanRoot: string, file: string, signal?: AbortSignal) =>
						this.mediaProbe!.probe(scanRoot, file, signal),
				}
				: {}),
		});
	}

	/** Monitor the configured directory using the platform filesystem watcher. */
	async createWatcher(
		library: Library,
		callbacks: SourceWatcherCallbacks,
	): Promise<SourceWatcher> {
		await this.validateConfig(library.sourceConfig);
		return createSourceWatcher(library.sourceConfig.scanRoot, callbacks);
	}
}
