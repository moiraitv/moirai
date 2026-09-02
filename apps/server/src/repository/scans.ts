import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type {
	Library,
	LibraryReconciliation,
	ScanIssue,
	ScanRun,
	SourceIdentity,
} from '@moirai/shared';
import {
	countLabel,
	REMOVAL_CONFIRMATION_INTERVAL_MINUTES,
	REMOVAL_CONFIRMATION_OBSERVATIONS,
} from '@moirai/shared';
import type { MoiraiDatabase } from '../db/index.js';
import {
	libraries,
	catalogConflicts,
	mediaGroups,
	mediaItemAliases,
	mediaItemGenres,
	mediaItemPeople,
	mediaRemovalTombstones,
	mediaItems,
	scanRuns,
} from '../db/schema.js';
import { internalErrorMessage } from '../error-message.js';
import { isMajorRemoval, sourceIdentityHash, sourceManifest } from '../scanner/source-health.js';
import { currentTimestamp } from '../time.js';
import type {
	DiscoveredGroup,
	DiscoveredItem,
	CatalogConflictObservation,
	ScanHistoryRetention,
	ReconciledScan,
	MissingItemPresenceBatch,
	ReconciledPresenceCheck,
} from './contracts.js';
import type { MissingItemPresenceObservation } from '../scanner/contracts.js';
import { preserveGroupIdentities } from './scan-identities.js';

/**
 * Own persisted scan lifecycle, source-health, tombstone, and reconciliation state. This repository
 * atomically applies healthy discovery, preserves stable catalog identities, and stages unsafe source
 * changes or removals for confirmation.
 */
export abstract class ScanRepository {
	constructor(protected readonly db: MoiraiDatabase) {}

	/** Notify the owning repository that media eligibility may have changed. */
	protected abstract catalogChanged(): void;

	/** Finalize scans abandoned by a prior process and return libraries needing recovery scans. */
	async recoverInterruptedScans(): Promise<string[]> {
		// Identify each affected library once, even if it has multiple abandoned records.
		const interrupted = await this.db
			.select({ libraryId: scanRuns.libraryId })
			.from(scanRuns)
			.where(eq(scanRuns.status, 'running'));
		const libraryIds = [...new Set(interrupted.map((run) => run.libraryId))];
		if (libraryIds.length === 0) {
			return [];
		}

		// Fail the abandoned runs and expose one recovery warning on their libraries.
		const completedAt = currentTimestamp();
		const issues: ScanIssue[] = [
			{
				path: null,
				code: 'scan_interrupted',
				message: 'The server stopped before this scan completed; a recovery scan was started.',
				severity: 'error',
			},
		];
		this.db.transaction((tx) => {
			tx.update(scanRuns)
				.set({ status: 'failed', completedAt, issues })
				.where(eq(scanRuns.status, 'running'))
				.run();
			tx.update(libraries)
				.set({ lastScanCompletedAt: completedAt, warningCount: 1, updatedAt: completedAt })
				.where(inArray(libraries.id, libraryIds))
				.run();
		});
		return libraryIds;
	}

	/** Create a running scan record and update library health state. */
	async beginScan(libraryId: string, trigger: ScanRun['trigger']): Promise<ScanRun> {
		const startedAt = currentTimestamp();
		const run: ScanRun = {
			id: randomUUID(),
			libraryId,
			trigger,
			status: 'running',
			startedAt,
			completedAt: null,
			discoveredCount: 0,
			changedCount: 0,
			removedCount: 0,
			issues: [],
		};

		await this.db.insert(scanRuns).values({ ...run, scanTrigger: trigger });
		await this.db
			.update(libraries)
			.set({ lastScanStartedAt: startedAt, updatedAt: startedAt })
			.where(eq(libraries.id, libraryId));

		return run;
	}

	/** Apply one completed discovery result transactionally to the media index. */
	async reconcileScan(
		run: ScanRun,
		groups: DiscoveredGroup[],
		items: DiscoveredItem[],
		issues: ScanIssue[],
		traversalComplete: boolean,
		sourceIdentity?: SourceIdentity,
		conflicts: CatalogConflictObservation[] = [],
	): Promise<ReconciledScan> {
		// Load the authored source state and the catalog snapshot this scan will reconcile.
		const [libraryState] = await this.db
			.select()
			.from(libraries)
			.where(eq(libraries.id, run.libraryId));
		if (!libraryState) {
			throw new Error('Library not found');
		}

		const observedSourceIdentity: SourceIdentity = sourceIdentity ?? {
			sourceType: libraryState.sourceType,
			sourceKey: libraryState.sourceConfig.scanRoot,
			details: {
				canonicalRoot: libraryState.sourceConfig.scanRoot,
				device: 'repository-call',
				inode: 'repository-call',
			},
		};
		const [existing, existingGroups] = await Promise.all([this.db
			.select({
				id: mediaItems.id,
				relativePath: mediaItems.relativePath,
				groupId: mediaItems.groupId,
				fingerprint: mediaItems.fingerprint,
				availability: mediaItems.availability,
				createdAt: mediaItems.createdAt,
			})
			.from(mediaItems)
			.where(eq(mediaItems.libraryId, run.libraryId)),
		this.db.select().from(mediaGroups).where(eq(mediaGroups.libraryId, run.libraryId)),
		]);

		// Preserve stable IDs and calculate catalog changes before writing discovered rows.
		preserveGroupIdentities(groups, items, existingGroups, existing);
		const previous = new Map(existing.map((item) => [item.relativePath, item]));
		const changedItemCount = items.filter((item) => {
			const prior = previous.get(item.relativePath);
			return prior?.fingerprint !== item.fingerprint || prior.availability !== 'available';
		}).length;
		const discoveredPaths = new Set(items.map((item) => item.relativePath));
		const absorbedItemIds = new Set(items.flatMap((item) => item.aliasIds));
		const missingItems = existing.filter(
			(item) => !discoveredPaths.has(item.relativePath) && !absorbedItemIds.has(item.id),
		);
		const changedCount
			= changedItemCount + missingItems.filter((item) => item.availability === 'available').length;

		// Decide whether this scan belongs to the accepted source or a candidate replacement.
		const identityHash = sourceIdentityHash(observedSourceIdentity);
		const acceptedIdentityHash = libraryState.acceptedSourceIdentity
			? sourceIdentityHash(libraryState.acceptedSourceIdentity)
			: null;
		const manifest = sourceManifest(items.map((item) => item.relativePath));
		const identityMismatch = Boolean(acceptedIdentityHash && acceptedIdentityHash !== identityHash);
		const candidateMode = Boolean(libraryState.pendingSourceDefinition || identityMismatch);
		const candidateMatches
			= libraryState.candidateManifest === manifest
				&& Boolean(
					libraryState.candidateSourceIdentity
					&& sourceIdentityHash(libraryState.candidateSourceIdentity) === identityHash,
				);

		// Quarantine a complete candidate until the operator approves replacing the source.
		if (
			traversalComplete
			&& candidateMode
			&& libraryState.reconciliationStatus !== 'source-accepting'
		) {
			const completedAt = currentTimestamp();
			const revision = candidateMatches
				? (libraryState.reconciliationRevision ?? randomUUID())
				: randomUUID();
			const candidateIssues: ScanIssue[] = [
				...issues,
				{
					path: null,
					code: libraryState.pendingSourceDefinition
						? 'source_change_requires_approval'
						: 'source_identity_requires_approval',
					message: 'The candidate source was inspected without changing the existing index. '
						+ 'Review and accept it before replacement.',
					severity: 'error',
				},
			];
			this.db.transaction((tx) => {
				tx.update(mediaItems)
					.set({ availability: 'unconfirmed' })
					.where(eq(mediaItems.libraryId, run.libraryId))
					.run();
				tx.update(scanRuns)
					.set({
						status: 'partial',
						completedAt,
						discoveredCount: items.length,
						changedCount: 0,
						removedCount: 0,
						issues: candidateIssues,
					})
					.where(eq(scanRuns.id, run.id))
					.run();
				tx.update(libraries)
					.set({
						candidateSourceIdentity: observedSourceIdentity,
						candidateManifest: manifest,
						candidateSummary: {
							discoveredCount: items.length,
							addedCount: items.filter((item) => !previous.has(item.relativePath)).length,
							missingCount: missingItems.length,
							observedAt: completedAt,
						},
						reconciliationStatus: 'source-approval-required',
						reconciliationRevision: revision,
						pendingRemovalCount: missingItems.length,
						sourceAvailability: 'degraded',
						sourceAvailabilityUpdatedAt: completedAt,
						lastScanCompletedAt: completedAt,
						warningCount: candidateIssues.length,
						updatedAt: completedAt,
					})
					.where(eq(libraries.id, run.libraryId))
					.run();
			});
			return {
				...run,
				status: 'partial',
				completedAt,
				discoveredCount: items.length,
				changedCount: 0,
				removedCount: 0,
				issues: candidateIssues,
				removedItemIds: [],
			};
		}

		// Retain the current index when a candidate source cannot be traversed completely.
		if (
			!traversalComplete
			&& candidateMode
			&& libraryState.reconciliationStatus !== 'source-accepting'
		) {
			const completedAt = currentTimestamp();
			const candidateIssues: ScanIssue[] = [
				...issues,
				{
					path: null,
					code: 'source_candidate_incomplete',
					message: 'The candidate source could not be traversed completely and was not imported.',
					severity: 'error',
				},
			];
			this.db.transaction((tx) => {
				tx.update(mediaItems)
					.set({ availability: 'unconfirmed' })
					.where(eq(mediaItems.libraryId, run.libraryId))
					.run();
				tx.update(mediaRemovalTombstones)
					.set({ consecutiveObservations: 0 })
					.where(eq(mediaRemovalTombstones.libraryId, run.libraryId))
					.run();
				tx.update(scanRuns)
					.set({
						status: 'partial',
						completedAt,
						discoveredCount: items.length,
						changedCount: 0,
						removedCount: 0,
						issues: candidateIssues,
					})
					.where(eq(scanRuns.id, run.id))
					.run();
				tx.update(libraries)
					.set({
						sourceAvailability: 'degraded',
						sourceAvailabilityUpdatedAt: completedAt,
						lastScanCompletedAt: completedAt,
						warningCount: candidateIssues.length,
						updatedAt: completedAt,
					})
					.where(eq(libraries.id, run.libraryId))
					.run();
			});
			return {
				...run,
				status: 'partial',
				completedAt,
				discoveredCount: items.length,
				changedCount: 0,
				removedCount: 0,
				issues: candidateIssues,
				removedItemIds: [],
			};
		}

		// Abort an approved replacement if its reviewed contents are no longer reproducible.
		if (
			libraryState.reconciliationStatus === 'source-accepting'
			&& (!traversalComplete || !candidateMatches)
		) {
			const reason = !traversalComplete
				? 'The accepted source could not be traversed completely.'
				: 'The source contents changed after review; review the refreshed candidate before accepting it.';
			await this.db
				.update(libraries)
				.set({
					reconciliationStatus: 'source-approval-required',
					reconciliationRevision: randomUUID(),
				})
				.where(eq(libraries.id, run.libraryId));
			throw new Error(reason);
		}

		// Build consecutive-observation tombstones for media missing from a healthy scan.
		const acceptingSource = libraryState.reconciliationStatus === 'source-accepting';
		const qualifiedObservation
			= traversalComplete
				&& (!acceptedIdentityHash || acceptedIdentityHash === identityHash || acceptingSource);
		const reconciledIssues = [...issues];
		const existingTombstones = await this.db
			.select()
			.from(mediaRemovalTombstones)
			.where(eq(mediaRemovalTombstones.libraryId, run.libraryId));
		const tombstonesByItem = new Map(existingTombstones.map((entry) => [entry.itemId, entry]));
		const completedAt = currentTimestamp();
		const minimumObservationMs = REMOVAL_CONFIRMATION_INTERVAL_MINUTES * 60_000;
		const nextTombstones = new Map<string, (typeof existingTombstones)[number]>();
		for (const missing of missingItems) {
			const prior = tombstonesByItem.get(missing.id);
			const sameIdentity = prior?.sourceIdentityHash === identityHash;
			const lastCountedAt = sameIdentity ? prior?.lastCountedAt : null;
			const enoughTimeElapsed
				= !lastCountedAt
					|| Date.parse(completedAt) - Date.parse(lastCountedAt) >= minimumObservationMs;
			const consecutiveObservations = qualifiedObservation
				? enoughTimeElapsed
					? (sameIdentity ? (prior?.consecutiveObservations ?? 0) : 0) + 1
					: (prior?.consecutiveObservations ?? 0)
				: 0;
			nextTombstones.set(missing.id, {
				itemId: missing.id,
				libraryId: run.libraryId,
				sourceIdentityHash: identityHash,
				firstMissingAt: sameIdentity ? (prior?.firstMissingAt ?? completedAt) : completedAt,
				lastMissingAt: completedAt,
				lastCountedAt: qualifiedObservation && enoughTimeElapsed
					? completedAt
					: (lastCountedAt ?? null),
				consecutiveObservations,
				lastScanId: run.id,
			});
		}

		// Confirm ordinary removals gradually and require approval for major catalog changes.
		const majorRemoval
			= qualifiedObservation && isMajorRemoval(existing.length, items.length, missingItems.length);
		const removableIds = acceptingSource
			? missingItems.map((item) => item.id)
			: majorRemoval
				? []
				: [...nextTombstones.values()]
					.filter((entry) => entry.consecutiveObservations >= REMOVAL_CONFIRMATION_OBSERVATIONS)
					.map((entry) => entry.itemId);
		const pendingRemovalCount = missingItems.length - removableIds.length;
		if (pendingRemovalCount > 0) {
			reconciledIssues.push({
				path: null,
				code: majorRemoval ? 'removal_approval_required' : 'removal_confirmation_pending',
				message: majorRemoval
					? `${countLabel(pendingRemovalCount, 'missing item')} ${
						pendingRemovalCount === 1 ? 'requires' : 'require'
					} explicit reconciliation.`
					: `${countLabel(pendingRemovalCount, 'missing item')} ${
						pendingRemovalCount === 1 ? 'is' : 'are'
					} awaiting ${countLabel(
						REMOVAL_CONFIRMATION_OBSERVATIONS,
						'healthy observation',
					)} at least ${countLabel(REMOVAL_CONFIRMATION_INTERVAL_MINUTES, 'minute')} apart.`,
				severity: majorRemoval ? 'error' : 'warning',
			});
		}
		const removedCount = removableIds.length;
		const sourceAvailability: Library['sourceAvailability'] = traversalComplete
			? 'available'
			: 'degraded';

		this.db.transaction((tx) => {
			// Replace source conflicts only after a complete traversal.
			if (traversalComplete) {
				tx.delete(catalogConflicts).where(eq(catalogConflicts.libraryId, run.libraryId)).run();
				if (conflicts.length > 0) {
					tx.insert(catalogConflicts)
						.values(conflicts.map((conflict) => ({
							...conflict,
							libraryId: run.libraryId,
							observedAt: completedAt,
						})))
						.run();
				}
			}

			// Upsert the discovered hierarchy before assigning media items to its groups.
			for (const group of groups) {
				const sourceKey = group.sourceKey ?? group.stableKey;
				tx.insert(mediaGroups)
					.values({
						...group,
						sourceKey,
						libraryId: run.libraryId,
						createdAt: completedAt,
						updatedAt: completedAt,
					})
					.onConflictDoUpdate({
						target: mediaGroups.id,
						set: { ...group, sourceKey, updatedAt: completedAt },
					})
					.run();
			}

			// Upsert media rows and replace normalized metadata only when an item changed.
			for (const item of items) {
				const { genres, people, aliasIds, ...indexedItem } = item;
				void aliasIds;
				tx.delete(mediaItemAliases).where(eq(mediaItemAliases.aliasId, item.id)).run();
				const prior = previous.get(item.relativePath);
				const firstIndexedAt = prior?.createdAt ?? completedAt;
				const dateAddedAt
					= item.fileModifiedAt < firstIndexedAt ? item.fileModifiedAt : firstIndexedAt;
				tx.insert(mediaItems)
					.values({
						...indexedItem,
						durationSeconds: null,
						libraryId: run.libraryId,
						availability: 'available',
						lastObservedAt: completedAt,
						dateAddedAt,
						createdAt: completedAt,
						updatedAt: completedAt,
					})
					.onConflictDoUpdate({
						target: [mediaItems.libraryId, mediaItems.relativePath],
						set: {
							...indexedItem,
							durationSeconds: null,
							availability: 'available',
							lastObservedAt: completedAt,
							dateAddedAt,
							updatedAt: completedAt,
						},
					})
					.run();
				if (prior?.fingerprint !== item.fingerprint) {
					tx.delete(mediaItemGenres).where(eq(mediaItemGenres.itemId, item.id)).run();
					tx.delete(mediaItemPeople).where(eq(mediaItemPeople.itemId, item.id)).run();
					if (genres.length > 0) {
						tx.insert(mediaItemGenres)
							.values(
								genres.map((genre) => ({
									itemId: item.id,
									libraryId: run.libraryId,
									genreKey: genre.key,
									genreName: genre.name,
								})),
							)
							.run();
					}
					if (people.length > 0) {
						tx.insert(mediaItemPeople)
							.values(
								people.map((person) => ({
									itemId: item.id,
									libraryId: run.libraryId,
									...person,
								})),
							)
							.onConflictDoNothing({
								target: [
									mediaItemPeople.itemId,
									mediaItemPeople.personType,
									mediaItemPeople.normalizedName,
								],
							})
							.run();
					}
				}
				tx.delete(mediaRemovalTombstones).where(eq(mediaRemovalTombstones.itemId, item.id)).run();
			}

			// Replace absorbed physical rows with compatibility aliases to the logical item.
			if (absorbedItemIds.size > 0) {
				tx.delete(mediaItems).where(inArray(mediaItems.id, [...absorbedItemIds])).run();
				for (const item of items) {
					if (item.aliasIds.length === 0) {
						continue;
					}

					tx.insert(mediaItemAliases)
						.values(item.aliasIds.map((aliasId) => ({
							aliasId,
							libraryId: run.libraryId,
							itemId: item.id,
							createdAt: completedAt,
						})))
						.onConflictDoUpdate({
							target: mediaItemAliases.aliasId,
							set: { itemId: item.id, libraryId: run.libraryId },
						})
						.run();
				}
			}

			// Persist missing-item observations for the next healthy reconciliation pass.
			for (const tombstone of nextTombstones.values()) {
				tx.insert(mediaRemovalTombstones)
					.values(tombstone)
					.onConflictDoUpdate({
						target: mediaRemovalTombstones.itemId,
						set: tombstone,
					})
					.run();
			}

			// Flag missing media items while their removal awaits confirmation.
			if (missingItems.length > 0) {
				tx.update(mediaItems)
					.set({ availability: 'unconfirmed' })
					.where(
						inArray(
							mediaItems.id,
							missingItems.map((item) => item.id),
						),
					)
					.run();
			}

			// Delete confirmed removals and prune groups that no longer contain media.
			if (removableIds.length > 0) {
				tx.delete(mediaItems).where(inArray(mediaItems.id, removableIds)).run();
				tx.run(sql`DELETE FROM media_groups
          WHERE library_id = ${run.libraryId}
          AND NOT EXISTS (
            SELECT 1 FROM media_items WHERE media_items.group_id = media_groups.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM media_groups AS child_groups
            JOIN media_items AS child_items ON child_items.group_id = child_groups.id
            WHERE child_groups.parent_id = media_groups.id
          )`);
			}

			// Finalize scan history and publish the library's resulting health state.
			const status = traversalComplete
				? reconciledIssues.some((issue) => issue.severity === 'error')
					? 'partial'
					: 'complete'
				: 'partial';
			tx.update(scanRuns)
				.set({
					status,
					completedAt,
					discoveredCount: items.length,
					changedCount,
					removedCount,
					issues: reconciledIssues,
				})
				.where(eq(scanRuns.id, run.id))
				.run();
			tx.update(libraries)
				.set({
					...(acceptingSource
						? {
							typeKey: libraryState.pendingSourceDefinition?.typeKey ?? libraryState.typeKey,
							sourceType: libraryState.pendingSourceDefinition?.sourceType
								?? libraryState.sourceType,
							sourceConfig: libraryState.pendingSourceDefinition?.sourceConfig
								?? libraryState.sourceConfig,
							acceptedSourceIdentity: observedSourceIdentity,
							pendingSourceDefinition: null,
							candidateSourceIdentity: null,
							candidateManifest: null,
							candidateSummary: null,
						}
						: qualifiedObservation
							? { acceptedSourceIdentity: observedSourceIdentity }
							: {}),
					...(!candidateMode && libraryState.candidateSourceIdentity
						? {
							candidateSourceIdentity: null,
							candidateManifest: null,
							candidateSummary: null,
						}
						: {}),
					lastScanCompletedAt: completedAt,
					lastIndexedChangeAt: changedCount > 0 || removedCount > 0 || missingItems.length > 0
						? completedAt
						: undefined,
					warningCount: reconciledIssues.length,
					sourceAvailability,
					sourceAvailabilityUpdatedAt: completedAt,
					reconciliationStatus: pendingRemovalCount === 0
						? 'idle'
						: majorRemoval
							? 'removal-approval-required'
							: 'observing-removals',
					reconciliationRevision: pendingRemovalCount > 0 ? randomUUID() : null,
					pendingRemovalCount,
					updatedAt: completedAt,
				})
				.where(eq(libraries.id, run.libraryId))
				.run();
		});

		return {
			...run,
			status: traversalComplete
				&& !reconciledIssues.some((issue) => issue.severity === 'error')
				? 'complete'
				: 'partial',
			completedAt,
			discoveredCount: items.length,
			changedCount,
			removedCount,
			issues: reconciledIssues,
			removedItemIds: removableIds,
		};
	}

	/** Return the current tombstone and source-health reconciliation state. */
	async getLibraryReconciliation(libraryId: string): Promise<LibraryReconciliation | null> {
		const [state] = await this.db.select().from(libraries).where(eq(libraries.id, libraryId));
		if (!state) {
			return null;
		}

		const missingItems = await this.db
			.select({
				id: mediaItems.id,
				title: mediaItems.title,
				relativePath: mediaItems.relativePath,
				firstMissingAt: mediaRemovalTombstones.firstMissingAt,
				consecutiveObservations: mediaRemovalTombstones.consecutiveObservations,
			})
			.from(mediaRemovalTombstones)
			.innerJoin(mediaItems, eq(mediaItems.id, mediaRemovalTombstones.itemId))
			.where(eq(mediaRemovalTombstones.libraryId, libraryId))
			.orderBy(asc(mediaItems.relativePath))
			.limit(50);
		return {
			libraryId,
			status: state.reconciliationStatus,
			pendingRemovalCount: state.pendingRemovalCount,
			requiredObservations: REMOVAL_CONFIRMATION_OBSERVATIONS,
			observationIntervalMinutes: REMOVAL_CONFIRMATION_INTERVAL_MINUTES,
			revision: state.reconciliationRevision,
			candidateSourceConfig: state.pendingSourceDefinition?.sourceConfig
				?? (state.candidateSourceIdentity ? state.sourceConfig : null),
			sourceChangeCanBeCancelled: Boolean(state.pendingSourceDefinition),
			candidateSummary: state.candidateSummary ?? null,
			missingItems,
		};
	}

	/** Return physical paths awaiting ordinary confirmation or major-removal healing. */
	async getMissingItemPresenceBatch(libraryId: string): Promise<MissingItemPresenceBatch | null> {
		const [state] = await this.db
			.select({
				status: libraries.reconciliationStatus,
				revision: libraries.reconciliationRevision,
			})
			.from(libraries)
			.where(eq(libraries.id, libraryId));
		if (
			!state?.revision
			|| !['observing-removals', 'removal-approval-required'].includes(state.status)
		) {
			return null;
		}

		const rows = await this.db
			.select({
				itemId: mediaItems.id,
				stableKey: mediaItems.stableKey,
				relativePath: mediaItems.relativePath,
				parts: mediaItems.parts,
				firstMissingAt: mediaRemovalTombstones.firstMissingAt,
				lastCountedAt: mediaRemovalTombstones.lastCountedAt,
			})
			.from(mediaRemovalTombstones)
			.innerJoin(mediaItems, eq(mediaItems.id, mediaRemovalTombstones.itemId))
			.where(eq(mediaRemovalTombstones.libraryId, libraryId));
		if (rows.length === 0) {
			return null;
		}

		const intervalMilliseconds = REMOVAL_CONFIRMATION_INTERVAL_MINUTES * 60_000;
		const nextCheckAt = new Date(Math.min(...rows.map(
			(row) => Date.parse(row.lastCountedAt ?? row.firstMissingAt) + intervalMilliseconds,
		))).toISOString();
		return {
			revision: state.revision,
			nextCheckAt,
			mode: state.status === 'removal-approval-required' ? 'heal-only' : 'confirmation',
			targets: rows.map((row) => ({
				itemId: row.itemId,
				stableKey: row.stableKey,
				relativePaths: [...new Set(
					row.parts.length > 0
						? row.parts.map((part) => part.relativePath)
						: [row.relativePath],
				)],
			})),
		};
	}

	/** Apply path-only healing or ordinary confirmation against the current reconciliation revision. */
	async applyMissingItemPresence(
		libraryId: string,
		revision: string,
		sourceIdentity: SourceIdentity,
		observations: MissingItemPresenceObservation[],
	): Promise<ReconciledPresenceCheck> {
		const timestamp = currentTimestamp();
		const identityHash = sourceIdentityHash(sourceIdentity);
		const observationByItem = new Map(observations.map((entry) => [entry.itemId, entry.status]));
		const result = this.db.transaction((tx): ReconciledPresenceCheck => {
			// Recheck source and reconciliation ownership inside the write transaction.
			const [state] = tx
				.select({
					status: libraries.reconciliationStatus,
					revision: libraries.reconciliationRevision,
					warningCount: libraries.warningCount,
				})
				.from(libraries)
				.where(eq(libraries.id, libraryId))
				.all();
			const tombstones = tx
				.select()
				.from(mediaRemovalTombstones)
				.where(eq(mediaRemovalTombstones.libraryId, libraryId))
				.all();
			if (
				!state
				|| !['observing-removals', 'removal-approval-required'].includes(state.status)
				|| state.revision !== revision
				|| tombstones.length === 0
				|| tombstones.some((entry) => entry.sourceIdentityHash !== identityHash)
			) {
				return {
					applied: false,
					changed: false,
					removedItemIds: [],
					presentItemIds: [],
					restoredItemIds: [],
					pendingRemovalCount: tombstones.length,
				};
			}

			// Restore present major-removal items and advance only ordinary absent observations.
			const healOnly = state.status === 'removal-approval-required';
			const minimumObservationMs = REMOVAL_CONFIRMATION_INTERVAL_MINUTES * 60_000;
			const presentItemIds: string[] = [];
			const removableIds: string[] = [];
			let changed = false;
			for (const tombstone of tombstones) {
				const observation = observationByItem.get(tombstone.itemId) ?? 'inconclusive';
				if (observation === 'present') {
					presentItemIds.push(tombstone.itemId);
					continue;
				}

				if (observation !== 'absent' || healOnly) {
					continue;
				}

				const enoughTimeElapsed = !tombstone.lastCountedAt
					|| Date.parse(timestamp) - Date.parse(tombstone.lastCountedAt) >= minimumObservationMs;
				const consecutiveObservations = enoughTimeElapsed
					? tombstone.consecutiveObservations + 1
					: tombstone.consecutiveObservations;
				tx.update(mediaRemovalTombstones)
					.set({
						lastMissingAt: timestamp,
						lastCountedAt: enoughTimeElapsed ? timestamp : tombstone.lastCountedAt,
						consecutiveObservations,
					})
					.where(eq(mediaRemovalTombstones.itemId, tombstone.itemId))
					.run();
				changed ||= enoughTimeElapsed;
				if (consecutiveObservations >= REMOVAL_CONFIRMATION_OBSERVATIONS) {
					removableIds.push(tombstone.itemId);
				}
			}
			if (healOnly && presentItemIds.length > 0) {
				tx.update(mediaItems)
					.set({ availability: 'available', lastObservedAt: timestamp, updatedAt: timestamp })
					.where(inArray(mediaItems.id, presentItemIds))
					.run();
				tx.delete(mediaRemovalTombstones)
					.where(inArray(mediaRemovalTombstones.itemId, presentItemIds))
					.run();
				changed = true;
			}

			// Delete confirmed items and move the library to its next reconciliation revision.
			if (removableIds.length > 0) {
				tx.delete(mediaItems).where(inArray(mediaItems.id, removableIds)).run();
				tx.run(sql`DELETE FROM media_groups
          WHERE library_id = ${libraryId}
          AND NOT EXISTS (
            SELECT 1 FROM media_items WHERE media_items.group_id = media_groups.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM media_groups AS child_groups
            JOIN media_items AS child_items ON child_items.group_id = child_groups.id
            WHERE child_groups.parent_id = media_groups.id
          )`);
			}

			const restoredCount = healOnly ? presentItemIds.length : 0;
			const pendingRemovalCount = tombstones.length - removableIds.length - restoredCount;
			if (changed) {
				tx.update(libraries)
					.set({
						reconciliationStatus: pendingRemovalCount === 0
							? 'idle'
							: healOnly
								? 'removal-approval-required'
								: 'observing-removals',
						reconciliationRevision: pendingRemovalCount === 0 ? null : randomUUID(),
						pendingRemovalCount,
						lastIndexedChangeAt: removableIds.length > 0 || restoredCount > 0
							? timestamp
							: undefined,
						warningCount: pendingRemovalCount === 0
							? Math.max(0, state.warningCount - 1)
							: state.warningCount,
						updatedAt: timestamp,
					})
					.where(and(eq(libraries.id, libraryId), eq(libraries.reconciliationRevision, revision)))
					.run();
			}

			return {
				applied: true,
				changed,
				removedItemIds: removableIds,
				presentItemIds,
				restoredItemIds: healOnly ? presentItemIds : [],
				pendingRemovalCount,
			};
		});
		if (result.removedItemIds.length > 0 || result.restoredItemIds.length > 0) {
			this.catalogChanged();
		}

		return result;
	}

	/** Apply operator-approved tombstones after validating their revision. */
	async confirmLibraryRemovals(libraryId: string, revision: string): Promise<boolean> {
		// Reject stale confirmations so a newer scan cannot be reconciled accidentally.
		const [state] = await this.db
			.select({
				revision: libraries.reconciliationRevision,
				status: libraries.reconciliationStatus,
			})
			.from(libraries)
			.where(eq(libraries.id, libraryId));
		if (
			!state
			|| state.revision !== revision
			|| !['observing-removals', 'removal-approval-required'].includes(state.status)
		) {
			return false;
		}

		// Remove confirmed media, prune empty hierarchy rows, and clear reconciliation state.
		const timestamp = currentTimestamp();
		this.db.transaction((tx) => {
			tx.run(sql`DELETE FROM media_items
        WHERE library_id = ${libraryId}
        AND id IN (
          SELECT item_id FROM media_removal_tombstones WHERE library_id = ${libraryId}
        )`);
			tx.run(sql`DELETE FROM media_groups
        WHERE library_id = ${libraryId}
        AND NOT EXISTS (
          SELECT 1 FROM media_items WHERE media_items.group_id = media_groups.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM media_groups AS child_groups
          JOIN media_items AS child_items ON child_items.group_id = child_groups.id
          WHERE child_groups.parent_id = media_groups.id
        )`);
			tx.update(libraries)
				.set({
					reconciliationStatus: 'idle',
					reconciliationRevision: null,
					pendingRemovalCount: 0,
					lastIndexedChangeAt: timestamp,
					updatedAt: timestamp,
				})
				.where(and(eq(libraries.id, libraryId), eq(libraries.reconciliationRevision, revision)))
				.run();
		});
		this.catalogChanged();
		return true;
	}

	/** Accept a reviewed replacement source only if its identity still matches. */
	async authorizeSourceAcceptance(libraryId: string, revision: string): Promise<boolean> {
		const result = await this.db
			.update(libraries)
			.set({ reconciliationStatus: 'source-accepting', updatedAt: currentTimestamp() })
			.where(
				and(
					eq(libraries.id, libraryId),
					eq(libraries.reconciliationStatus, 'source-approval-required'),
					eq(libraries.reconciliationRevision, revision),
				),
			);
		return result.changes > 0;
	}

	/** Discard a staged source definition when its review revision is still current. */
	async cancelSourceChange(libraryId: string, revision: string): Promise<boolean> {
		const [state] = await this.db
			.select({ pending: libraries.pendingSourceDefinition })
			.from(libraries)
			.where(and(eq(libraries.id, libraryId), eq(libraries.reconciliationRevision, revision)));
		if (!state?.pending) {
			return false;
		}

		const result = await this.db
			.update(libraries)
			.set({
				pendingSourceDefinition: null,
				candidateSourceIdentity: null,
				candidateManifest: null,
				candidateSummary: null,
				reconciliationStatus: 'idle',
				reconciliationRevision: null,
				pendingRemovalCount: 0,
				sourceAvailability: 'unknown',
				updatedAt: currentTimestamp(),
			})
			.where(eq(libraries.id, libraryId));
		return result.changes > 0;
	}

	/** Finish a scan as failed while retaining the last known index. */
	async failScan(run: ScanRun, error: unknown, sourceUnavailable = false): Promise<ScanRun> {
		// Record the safe failure detail without discarding previously indexed media.
		const completedAt = currentTimestamp();
		const issues: ScanIssue[] = [
			{
				path: null,
				code: 'scan_failed',
				message: internalErrorMessage(error),
				severity: 'error',
			},
		];
		this.db.transaction((tx) => {
			tx.update(scanRuns)
				.set({ status: 'failed', completedAt, issues })
				.where(eq(scanRuns.id, run.id))
				.run();
			tx.update(libraries)
				.set({
					lastScanCompletedAt: completedAt,
					warningCount: 1,
					...(sourceUnavailable
						? {
							sourceAvailability: 'unavailable' as const,
							sourceAvailabilityUpdatedAt: completedAt,
						}
						: {}),
					updatedAt: completedAt,
				})
				.where(eq(libraries.id, run.libraryId))
				.run();

			// Only a confirmed source outage invalidates availability for the whole library.
			if (sourceUnavailable) {
				tx.update(mediaItems)
					.set({ availability: 'unconfirmed' })
					.where(eq(mediaItems.libraryId, run.libraryId))
					.run();
			}
			tx.update(mediaRemovalTombstones)
				.set({ consecutiveObservations: 0 })
				.where(eq(mediaRemovalTombstones.libraryId, run.libraryId))
				.run();
		});
		return { ...run, status: 'failed', completedAt, issues };
	}

	/** Mark a cooperatively aborted scan without changing availability or removal observations. */
	async cancelScan(run: ScanRun): Promise<ScanRun> {
		const completedAt = currentTimestamp();
		const issues: ScanIssue[] = [
			{
				path: null,
				code: 'scan_cancelled',
				message: 'The scan was cancelled before reconciliation.',
				severity: 'warning',
			},
		];
		await this.db
			.update(scanRuns)
			.set({ status: 'cancelled', completedAt, issues })
			.where(eq(scanRuns.id, run.id));
		await this.db
			.update(libraries)
			.set({ lastScanCompletedAt: completedAt, updatedAt: completedAt })
			.where(eq(libraries.id, run.libraryId));
		return { ...run, status: 'cancelled', completedAt, issues };
	}

	/** List the newest retained scan runs for one library. */
	async listScans(libraryId: string, limit = 20): Promise<ScanRun[]> {
		const rows = await this.db
			.select()
			.from(scanRuns)
			.where(eq(scanRuns.libraryId, libraryId))
			.orderBy(desc(scanRuns.startedAt))
			.limit(limit);
		return rows.map(({ scanTrigger, ...row }) => ({ ...row, trigger: scanTrigger }) as ScanRun);
	}

	/** Delete completed scan history outside the configured retention bounds. */
	pruneScanHistory(retention: ScanHistoryRetention, reference = new Date()): void {
		// Apply the age limit first, then enforce a per-library record cap.
		const scanCutoff = new Date(
			reference.getTime() - retention.scanDays * 86_400_000,
		).toISOString();
		this.db.transaction((tx) => {
			tx.run(sql`DELETE FROM scan_runs
        WHERE status <> 'running' AND completed_at IS NOT NULL AND completed_at < ${scanCutoff}`);
			tx.run(sql`DELETE FROM scan_runs WHERE id IN (
        SELECT id FROM (
          SELECT id, row_number() OVER (
            PARTITION BY library_id ORDER BY started_at DESC, id DESC
          ) AS retained_rank
          FROM scan_runs WHERE status <> 'running'
        ) WHERE retained_rank > ${retention.scansPerLibrary}
      )`);
		});
	}
}
