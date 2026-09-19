import { randomUUID } from 'node:crypto';
import { asc, eq, inArray } from 'drizzle-orm';
import type {
	Library,
	LibraryCreate,
	LibraryUpdate,
} from '@moirai/shared';
import { canonicalIdentityKey } from '@moirai/shared';
import type { MoiraiDatabase } from '../db/index.js';
import { ScanRepository } from './scans.js';
import {
	libraries,
	mediaItems,
} from '../db/schema.js';
import { ResourceIdentityConflictError } from './resource-identity.js';
import { currentTimestamp } from '../time.js';

/**
 * Own persisted library definitions, source identity, and public source-health state. This repository
 * extends scan reconciliation with configuration lifecycle, canonical name enforcement, and bounded
 * removal-review workflows.
 */
export abstract class LibraryRepository extends ScanRepository {
	constructor(db: MoiraiDatabase) {
		super(db);
	}

	/** List configured media libraries in creation order. */
	async listLibraries(): Promise<Library[]> {
		const rows = await this.db.select().from(libraries).orderBy(asc(libraries.name));
		return rows.map((library) => this.publicLibrary(library));
	}

	/** Resolve only requested libraries' trusted playback roots in bounded batches. */
	async getLibraryPlaybackRoots(ids: string[]): Promise<Map<string, string>> {
		const unique = [...new Set(ids)];
		const roots = new Map<string, string>();
		for (let offset = 0; offset < unique.length; offset += 500) {
			const rows = await this.db.select({ id: libraries.id, config: libraries.sourceConfig })
				.from(libraries).where(inArray(libraries.id, unique.slice(offset, offset + 500)));
			for (const row of rows) {
				roots.set(row.id, row.config.playbackRoot ?? row.config.scanRoot);
			}
		}
		return roots;
	}

	/** Return one configured media library. */
	async getLibrary(id: string): Promise<Library | null> {
		const [row] = await this.db.select().from(libraries).where(eq(libraries.id, id));
		return row ? this.publicLibrary(row) : null;
	}

	/** Remove reconciliation-only fields from a stored library row. */
	private publicLibrary(row: typeof libraries.$inferSelect): Library {
		const library = { ...row } as Partial<typeof row> & Record<string, unknown>;
		for (const privateField of [
			'nameKey',
			'acceptedSourceIdentity',
			'pendingSourceDefinition',
			'candidateSourceIdentity',
			'candidateManifest',
			'candidateSummary',
			'reconciliationRevision',
		]) {
			delete library[privateField];
		}
		return library as Library;
	}

	/** Return the source configuration and prior identity needed for scanning. */
	async getLibraryScanTarget(id: string): Promise<Library | null> {
		const library = await this.getLibrary(id);
		if (!library) {
			return null;
		}

		const [state] = await this.db
			.select({ pending: libraries.pendingSourceDefinition })
			.from(libraries)
			.where(eq(libraries.id, id));
		return state?.pending ? { ...library, ...state.pending } : library;
	}

	/** Persist a new media library configuration. */
	async createLibrary(input: LibraryCreate): Promise<Library> {
		const timestamp = currentTimestamp();
		const id = randomUUID();
		const nameKey = canonicalIdentityKey(input.name);
		const [conflict] = await this.db
			.select({ id: libraries.id })
			.from(libraries)
			.where(eq(libraries.nameKey, nameKey))
			.limit(1);
		if (conflict) {
			throw new ResourceIdentityConflictError('library');
		}

		await this.db.insert(libraries).values({
			id,
			...input,
			nameKey,
			sourceAvailability: 'unknown',
			sourceAvailabilityUpdatedAt: null,
			createdAt: timestamp,
			updatedAt: timestamp,
		});
		this.catalogChanged();
		return (await this.getLibrary(id))!;
	}

	/** Merge library configuration changes without altering indexed media. */
	async updateLibrary(
		id: string,
		input: LibraryUpdate,
		knownExisting?: Library,
	): Promise<Library | null> {
		const existing = knownExisting ?? (await this.getLibrary(id));
		if (!existing) {
			return null;
		}

		const merged = {
			name: input.name ?? existing.name,
			nameKey: canonicalIdentityKey(input.name ?? existing.name),
			typeKey: input.typeKey ?? existing.typeKey,
			sourceType: input.sourceType ?? existing.sourceType,
			sourceConfig: input.sourceConfig ?? existing.sourceConfig,
			scanIntervalMinutes: input.scanIntervalMinutes ?? existing.scanIntervalMinutes,
			watcherEnabled: input.watcherEnabled ?? existing.watcherEnabled,
			enabled: input.enabled ?? existing.enabled,
			updatedAt: currentTimestamp(),
		};
		const [conflict] = await this.db
			.select({ id: libraries.id })
			.from(libraries)
			.where(eq(libraries.nameKey, merged.nameKey))
			.limit(1);
		if (conflict && conflict.id !== id) {
			throw new ResourceIdentityConflictError('library');
		}

		await this.db.update(libraries).set(merged).where(eq(libraries.id, id));
		this.catalogChanged();
		return this.getLibrary(id);
	}

	/** Stage an identity-affecting definition without reinterpreting the existing catalog. */
	async stageLibrarySourceChange(
		id: string,
		input: LibraryUpdate,
		existing: Library,
	): Promise<Library | null> {
		const timestamp = currentTimestamp();
		const name = input.name ?? existing.name;
		const nameKey = canonicalIdentityKey(name);
		const [conflict] = await this.db
			.select({ id: libraries.id })
			.from(libraries)
			.where(eq(libraries.nameKey, nameKey))
			.limit(1);
		if (conflict && conflict.id !== id) {
			throw new ResourceIdentityConflictError('library');
		}

		await this.db
			.update(libraries)
			.set({
				name,
				nameKey,
				scanIntervalMinutes: input.scanIntervalMinutes ?? existing.scanIntervalMinutes,
				watcherEnabled: input.watcherEnabled ?? existing.watcherEnabled,
				enabled: input.enabled ?? existing.enabled,
				pendingSourceDefinition: {
					typeKey: input.typeKey ?? existing.typeKey,
					sourceType: input.sourceType ?? existing.sourceType,
					sourceConfig: input.sourceConfig ?? existing.sourceConfig,
				},
				candidateSourceIdentity: null,
				candidateManifest: null,
				candidateSummary: null,
				reconciliationStatus: 'source-approval-required',
				reconciliationRevision: randomUUID(),
				sourceAvailability: 'unknown',
				sourceAvailabilityUpdatedAt: timestamp,
				updatedAt: timestamp,
			})
			.where(eq(libraries.id, id));
		await this.db
			.update(mediaItems)
			.set({ availability: 'unconfirmed' })
			.where(eq(mediaItems.libraryId, id));
		this.catalogChanged();
		return this.getLibrary(id);
	}

	/** Delete a library and invalidate cached catalog scopes when it existed. */
	async deleteLibrary(id: string): Promise<boolean> {
		const result = await this.db.delete(libraries).where(eq(libraries.id, id));
		if (result.changes > 0) {
			this.catalogChanged();
		}
		return result.changes > 0;
	}

	/** Persist watcher lifecycle state without changing source availability. */
	async setWatcherStatus(id: string, watcherStatus: Library['watcherStatus']): Promise<void> {
		await this.db
			.update(libraries)
			.set({ watcherStatus, updatedAt: currentTimestamp() })
			.where(eq(libraries.id, id));
	}

	/** Record the time a watcher last observed a source change. */
	async markChangeDetected(id: string): Promise<void> {
		const timestamp = currentTimestamp();

		await this.db
			.update(libraries)
			.set({ lastChangeDetectedAt: timestamp, updatedAt: timestamp })
			.where(eq(libraries.id, id));
	}

}
