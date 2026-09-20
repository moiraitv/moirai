import { SemanticPreferenceRepository } from './semantic-preferences.js';
import { sql } from 'drizzle-orm';
import type { SemanticCatalog, SimilaritySeed, SelectionStateRecord } from '@moirai/shared';
import type { MoiraiDatabase } from '../db/index.js';
import { mediaGroups, mediaItems } from '../db/schema.js';
import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL_ID, EMBEDDING_MODEL_REVISION, SEMANTIC_INPUT_VERSION,
	semanticInput, semanticInputHash } from '../semantic/input.js';
import { normalizeVector } from '../semantic/ranking.js';

/** Catalog input whose hash is rechecked before inference results may be committed. */
export interface EmbeddingInput {
	id: string;
	text: string;
	hash: string;
}

/** Persisted model result, including durable failures for a particular input identity. */
interface EmbeddingRow {
	media_id: string;
	model_id: string;
	model_revision: string;
	input_version: number;
	input_hash: string;
	dimensions: number;
	embedding: Buffer | null;
	status: 'pending' | 'ready' | 'failed';
	error_code: string | null;
}

/** Decode only finite normalized float32 vectors from the selected model and input identity. */
function decode(row: EmbeddingRow): number[] | null {
	if (row.status !== 'ready' || row.dimensions !== EMBEDDING_DIMENSIONS
		|| row.embedding?.length !== EMBEDDING_DIMENSIONS * 4) {
		return null;
	}
	const values = Array.from({ length: EMBEDDING_DIMENSIONS }, (_, index) => row.embedding!.readFloatLE(index * 4));
	const norm = values.reduce((sum, value) => sum + value * value, 0);
	return values.every(Number.isFinite) && Math.abs(norm - 1) < 0.001 ? values : null;
}

/** A competing commit already advanced durable scheduling decisions; regenerate from SQLite. */
export class StaleSemanticDecisionError extends Error {}

/** Own SQLite semantic caches and immutable recommendation decisions, without running inference. */
export class SemanticRepository {
	readonly preferences: SemanticPreferenceRepository;

	constructor(private readonly db: MoiraiDatabase) {
		this.preferences = new SemanticPreferenceRepository(db);
	}

	/** Read semantic metadata in two bounded-query passes, including ancestor context. */
	inputs(itemIds?: string[], libraryIds?: string[]): EmbeddingInput[] {
		const selectedIds = itemIds ? JSON.stringify(itemIds) : libraryIds
			? JSON.stringify((this.db.$client.prepare('SELECT id FROM media_items WHERE library_id IN (SELECT value FROM json_each(?))').all(JSON.stringify(libraryIds)) as Array<{ id: string }>).map((item) => item.id)) : null;
		const ancestorScope = selectedIds ? sql`${mediaGroups.id} IN (
			WITH RECURSIVE ancestors(id) AS (
				SELECT group_id FROM media_items WHERE id IN (SELECT value FROM json_each(${selectedIds}))
				UNION SELECT g.parent_id FROM media_groups g JOIN ancestors a ON g.id=a.id WHERE g.parent_id IS NOT NULL
			) SELECT id FROM ancestors)` : undefined;
		const groups = new Map(this.db.select({ id: mediaGroups.id, parentId: mediaGroups.parentId, title: mediaGroups.title, kind: mediaGroups.kind, plot: mediaGroups.plot, metadata: mediaGroups.metadata }).from(mediaGroups).where(ancestorScope).all().map((group) => [group.id, group]));
		return this.db.select({ id: mediaItems.id, groupId: mediaItems.groupId, title: mediaItems.title, kind: mediaItems.kind, plot: mediaItems.plot, metadata: mediaItems.metadata, artists: mediaItems.artists }).from(mediaItems).where(selectedIds ? sql`${mediaItems.id} IN (SELECT value FROM json_each(${selectedIds}))` : undefined).all().map((item) => {
			const ancestors: Array<NonNullable<ReturnType<typeof groups.get>>> = [];
			const seen = new Set<string>();
			let id = item.groupId;
			while (id && !seen.has(id)) {
				seen.add(id);
				const group = groups.get(id);
				if (!group) {
					break;
				}
				ancestors.push(group);
				id = group.parentId;
			}
			const text = semanticInput(item, ancestors.reverse());
			return { id: item.id, text, hash: semanticInputHash(text) };
		});
	}

	/** Check all persisted components of an embedding identity. */
	private current(row: EmbeddingRow, input: EmbeddingInput): boolean {
		return row.input_hash === input.hash && row.model_id === EMBEDDING_MODEL_ID
			&& row.model_revision === EMBEDDING_MODEL_REVISION && row.input_version === SEMANTIC_INPUT_VERSION;
	}

	/** Reconcile metadata changes without touching files or requiring a library rescan. */
	reconcile(): EmbeddingInput[] {
		const inputs = this.inputs();
		const rows = new Map((this.db.$client.prepare('SELECT * FROM media_embeddings').all() as EmbeddingRow[])
			.map((row) => [row.media_id, row]));
		const pending = inputs.filter((input) => {
			const row = rows.get(input.id);
			return !row || !this.current(row, input) || row.status === 'pending'
				|| (row.status === 'ready' && !decode(row));
		});
		const write = this.db.$client.prepare(`INSERT INTO media_embeddings
			(media_id, model_id, model_revision, input_version, input_hash, dimensions, status)
			VALUES (?, ?, ?, ?, ?, ?, 'pending') ON CONFLICT(media_id) DO UPDATE SET
			model_id=excluded.model_id, model_revision=excluded.model_revision, input_version=excluded.input_version,
			input_hash=excluded.input_hash, dimensions=excluded.dimensions, status='pending', embedding=NULL,
			generated_at=NULL, error_code=NULL`);
		this.db.$client.transaction(() => {
			for (const input of pending) {
				write.run(input.id, EMBEDDING_MODEL_ID, EMBEDDING_MODEL_REVISION, SEMANTIC_INPUT_VERSION, input.hash, EMBEDDING_DIMENSIONS);
			}
		})();
		return pending;
	}

	/** Queue one explicit retry of failed media and concepts without touching seeds or ready vectors. */
	retryFailed(itemIds: string[], texts: string[]): number {
		return this.db.$client.transaction(() => {
			const media = this.db.$client.prepare("UPDATE media_embeddings SET status='pending',error_code=NULL,generated_at=NULL WHERE status='failed' AND media_id IN (SELECT value FROM json_each(?))")
				.run(JSON.stringify(itemIds)).changes;
			return media + this.preferences.retryFailed(texts);
		})();
	}

	/** Save one result using the same stale-input guard as background batches. */
	store(input: EmbeddingInput, vector: number[] | null): boolean {
		return this.storeBatch([{ input, vector }]) > 0;
	}

	/** Recheck semantic input once per batch and atomically store only still-current inference. */
	storeBatch(results: Array<{ input: EmbeddingInput; vector: number[] | null }>): number {
		const current = new Map(this.inputs(results.map((result) => result.input.id)).map((input) => [input.id, input.hash]));
		const update = this.db.$client.prepare(`UPDATE media_embeddings SET embedding=?, generated_at=?, status=?, error_code=?
			WHERE media_id=? AND input_hash=? AND model_revision=?`);
		return this.db.$client.transaction(() => {
			let stored = 0;
			for (const { input, vector } of results) {
				if (current.get(input.id) !== input.hash) {
					continue;
				}
				let blob: Buffer | null = null;
				if (vector) {
					if (vector.length !== EMBEDDING_DIMENSIONS) {
						throw new Error('Unexpected embedding dimensions');
					}
					blob = Buffer.alloc(EMBEDDING_DIMENSIONS * 4);
					normalizeVector(vector).forEach((value, index) => blob!.writeFloatLE(value, index * 4));
				}
				stored += update.run(
					blob,
					new Date().toISOString(),
					vector ? 'ready' : 'failed',
					vector ? null : 'inference-failed',
					input.id,
					input.hash,
					EMBEDDING_MODEL_REVISION,
				).changes;
			}
			return stored;
		})();
	}

	/** Preserve preparation errors without marking retryable model failures as permanent item errors. */
	preparationError(code: 'model-missing' | 'model-unavailable' | null): void {
		this.preferences.preparationError(code ? code === 'model-missing'
			? 'The matching model is missing. Reinstall the complete Moirai application.'
			: 'Local matching preparation is unavailable; Moirai will retry.' : null);
		this.db.$client.prepare("UPDATE media_embeddings SET error_code=? WHERE status='pending'").run(code);
	}

	/** Load durable seed membership in ordinal order, including deleted media identities. */
	seeds(programIds?: string[]): SimilaritySeed[] {
		const rows = this.db.$client.prepare(`SELECT s.*, i.media_id, i.ordinal FROM similarity_seeds s
			JOIN similarity_seed_items i USING(consumer_key, generation)
			WHERE (? IS NULL OR s.program_id IN (SELECT value FROM json_each(?)))
			ORDER BY s.consumer_key, s.generation, i.ordinal`).all(programIds ? JSON.stringify(programIds) : null, programIds ? JSON.stringify(programIds) : null) as Array<{
			consumer_key: string; generation: number; program_id: string; source_item_ids: string;
			config: string; created_at: string; media_id: string;
		}>;
		const seeds = new Map<string, SimilaritySeed>();
		for (const row of rows) {
			const key = `${row.consumer_key}:${row.generation}`;
			let seed = seeds.get(key);
			if (!seed) {
				seed = { consumerKey: row.consumer_key, generation: row.generation, programId: row.program_id,
					config: JSON.parse(row.config), sourceItemIds: JSON.parse(row.source_item_ids),
					createdAt: row.created_at, itemIds: [] };
				seeds.set(key, seed);
			}
			seed.itemIds.push(row.media_id);
		}
		return [...seeds.values()];
	}

	/** Attach current vectors only; a stale cached vector must never enter a new recommendation. */
	catalog(scope?: { libraryIds: string[]; programIds: string[] }): SemanticCatalog {
		const inputs = new Map(this.inputs(undefined, scope?.libraryIds).map((input) => [input.id, input]));
		const vectors: Record<string, number[]> = {};
		const failedItemIds: string[] = [];
		let preparationError: string | undefined;
		const rows = scope
			? this.db.$client.prepare('SELECT e.* FROM media_embeddings e JOIN media_items m ON m.id=e.media_id WHERE m.library_id IN (SELECT value FROM json_each(?))').all(JSON.stringify(scope.libraryIds))
			: this.db.$client.prepare('SELECT * FROM media_embeddings').all();
		for (const row of rows as EmbeddingRow[]) {
			const input = inputs.get(row.media_id);
			if (!input || !this.current(row, input)) {
				continue;
			}
			if (row.status === 'pending' && row.error_code) {
				preparationError = row.error_code === 'model-missing' ? 'The matching model is missing. Reinstall the complete Moirai application.' : 'Local matching preparation is unavailable; Moirai will retry.';
			}
			const vector = decode(row);
			if (vector) {
				vectors[row.media_id] = vector;
				inputs.delete(row.media_id);
			}
			else if (row.status === 'failed') {
				failedItemIds.push(row.media_id);
				inputs.delete(row.media_id);
			}
		}
		const currentSets = (this.db.$client.prepare("SELECT s.value, c.name AS channelName FROM selection_states s JOIN channels c ON c.id=s.channel_id WHERE json_extract(s.value, '$.type')='similarity' AND (? IS NULL OR json_extract(s.value, '$.seed.programId') IN (SELECT value FROM json_each(?)))").all(scope ? JSON.stringify(scope.programIds) : null, scope ? JSON.stringify(scope.programIds) : null) as Array<{ value: string; channelName: string }>).map((row) => {
			const value = JSON.parse(row.value) as Extract<SelectionStateRecord['value'], { type: 'similarity' }>;
			return { channelName: row.channelName, programId: value.seed.programId, consumerKey: value.seed.consumerKey,
				generation: value.seed.generation, total: value.seed.itemIds.length, requestedTotal: value.seed.config.quantity,
				remaining: value.seed.itemIds.filter((id) => !value.consumedItemIds.includes(id)).length };
		});
		return { vectors, pendingItemIds: [...inputs.keys()], failedItemIds, seeds: this.seeds(scope?.programIds), currentSets,
			...(preparationError ? { preparationError } : {}) };
	}

	/** Prune decisions older than every retained checkpoint, keeping future committed generations. */
	pruneSeeds(): void {
		this.db.$client.exec(`WITH retained AS (
			SELECT consumer_key, CAST(json_extract(value, '$.seed.generation') AS INTEGER) generation
			FROM selection_states WHERE json_extract(value, '$.type')='similarity'
			UNION ALL
			SELECT json_extract(j.value, '$.consumerKey'), json_extract(j.value, '$.value.seed.generation')
			FROM timeline_materializations t, json_each(t.base_state) j WHERE json_extract(j.value, '$.value.type')='similarity'
			UNION ALL
			SELECT json_extract(j.value, '$.consumerKey'), json_extract(j.value, '$.value.seed.generation')
			FROM materialized_timeline_segments t, json_each(t.state_delta) j WHERE json_extract(j.value, '$.value.type')='similarity'
		) DELETE FROM similarity_seeds WHERE generation <
			(SELECT MIN(generation) FROM retained WHERE retained.consumer_key=similarity_seeds.consumer_key)`);
	}

	/** Write immutable decisions inside the caller's timeline transaction; reject conflicting proposals. */
	commitSeeds(channelId: string, states: SelectionStateRecord[]): void {
		const existing = new Map(this.seeds().map((seed) => [`${seed.consumerKey}:${seed.generation}`, seed]));
		for (const record of states) {
			if (record.value.type !== 'similarity') {
				continue;
			}
			const seed = record.value.seed;
			const key = `${seed.consumerKey}:${seed.generation}`;
			const prior = existing.get(key);
			if (prior) {
				if (JSON.stringify(prior.itemIds) !== JSON.stringify(seed.itemIds)
					|| JSON.stringify(prior.config) !== JSON.stringify(seed.config)
					|| JSON.stringify(prior.sourceItemIds) !== JSON.stringify(seed.sourceItemIds)) {
					throw new StaleSemanticDecisionError('Stale semantic seed proposal; retry scheduling');
				}
				continue;
			}
			// Deleted Program checkpoints remain readable, but no longer own live seed rows.
			const inserted = this.db.$client.prepare(`INSERT INTO similarity_seeds
				SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM scheduling_programs WHERE id=?)`)
				.run(
					seed.consumerKey,
					seed.generation,
					seed.programId,
					channelId,
					JSON.stringify(seed.sourceItemIds),
					JSON.stringify(seed.config),
					seed.createdAt,
					seed.programId,
				);
			if (!inserted.changes) {
				continue;
			}
			const insert = this.db.$client.prepare('INSERT INTO similarity_seed_items VALUES (?, ?, ?, ?)');
			seed.itemIds.forEach((id, ordinal) => insert.run(seed.consumerKey, seed.generation, id, ordinal));
			existing.set(key, seed);
		}
	}
}
