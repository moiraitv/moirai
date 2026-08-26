import type { LibrarySourceAdapter, SourceConfigurationImpact } from './contracts.js';
import { UnsupportedLibrarySourceError } from './contracts.js';

/**
 * Own the immutable set of scanner adapters available to this server process. The registry resolves
 * provider-neutral source types and routes validation and change classification to the owning adapter.
 */
export class LibrarySourceRegistry {
	private readonly adapters = new Map<string, LibrarySourceAdapter>();

	constructor(adapters: LibrarySourceAdapter[]) {
		for (const adapter of adapters) {
			if (this.adapters.has(adapter.sourceType)) {
				throw new Error(`Duplicate library source adapter: ${adapter.sourceType}`);
			}

			this.adapters.set(adapter.sourceType, adapter);
		}
	}

	/** Return registered source types in deterministic registration order. */
	get sourceTypes(): string[] {
		return [...this.adapters.keys()];
	}

	/** Resolve one adapter or fail before source-specific work begins. */
	require(sourceType: string): LibrarySourceAdapter {
		const adapter = this.adapters.get(sourceType);
		if (!adapter) {
			throw new UnsupportedLibrarySourceError(sourceType);
		}

		return adapter;
	}

	/** Validate one source definition through its owning adapter. */
	async validate(sourceType: string, config: unknown): Promise<void> {
		await this.require(sourceType).validateConfig(config);
	}

	/** Classify one validated configuration change through its owning adapter. */
	configurationImpact(
		sourceType: string,
		previous: unknown,
		next: unknown,
	): SourceConfigurationImpact {
		return this.require(sourceType).configurationImpact(previous, next);
	}
}
