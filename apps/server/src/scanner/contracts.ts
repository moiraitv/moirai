import type {
	Library,
	ScanIssue,
	ScanProgress,
	SourceIdentity,
} from '@moirai/shared';
import type {
	CatalogConflictObservation,
	DiscoveredGroup,
	DiscoveredItem,
	MediaProbeCacheEntry,
} from '../repository/contracts.js';

/** Media, hierarchy, and recoverable issues produced by one source scan. */
export interface ScanDiscovery {
	groups: DiscoveredGroup[];
	items: DiscoveredItem[];
	issues: ScanIssue[];
	traversalComplete: boolean;
	sourceIdentity: SourceIdentity;
	conflicts: CatalogConflictObservation[];
}

/** Shared lifecycle inputs supplied to one source adapter discovery pass. */
export interface ScanContext {
	signal: AbortSignal;
	probeCache: Map<string, MediaProbeCacheEntry>;
	onProgress: (progress: ScanProgress) => void;
}

/** Callbacks used by an optional provider-specific live change monitor. */
export interface SourceWatcherCallbacks {
	onChange: () => void;
	onError: (error: unknown) => void;
}

/** Closeable provider monitor retained by the scanner manager. */
export interface SourceWatcher {
	close(): Promise<void>;
}

/** Reconciliation work required after a source adapter configuration change. */
export type SourceConfigurationImpact = 'none' | 'index' | 'identity';

/** Scanner boundary implemented once for each registered library source type. */
export interface LibrarySourceAdapter {
	readonly sourceType: string;
	readonly usesMediaProbeCache?: boolean;
	validateConfig(config: unknown): Promise<void>;
	configurationImpact(previous: unknown, next: unknown): SourceConfigurationImpact;
	discover(library: Library, context: ScanContext): Promise<ScanDiscovery>;
	createWatcher?(
		library: Library,
		callbacks: SourceWatcherCallbacks,
	): Promise<SourceWatcher>;
}

/** Safe provider-authored validation failure returned by library configuration routes. */
export class InvalidLibrarySourceConfigurationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'InvalidLibrarySourceConfigurationError';
	}
}

/** Failure raised when a persisted or requested source type has no registered adapter. */
export class UnsupportedLibrarySourceError extends Error {
	constructor(public readonly sourceType: string) {
		super(`Unsupported source: ${sourceType}`);
		this.name = 'UnsupportedLibrarySourceError';
	}
}
