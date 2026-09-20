import { refinementTexts } from '../semantic/refinement.js';
import type { ProgramConfig } from '@moirai/shared';
import type { SemanticCatalog } from '@moirai/shared';
import type { MoiraiDatabase } from '../db/index.js';
import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL_ID, EMBEDDING_MODEL_REVISION, semanticInputHash } from '../semantic/input.js';
import { normalizeVector } from '../semantic/ranking.js';

/** Maximum number of unsaved prompt identities retained for editor previews. */
export const PREFERENCE_DRAFT_LIMIT = 256;
/** Maximum prompts inferred before yielding back to media backfill. */
export const PREFERENCE_BATCH_SIZE = 20;

/** Hash prompt text with its inference identity so model changes never reuse old vectors. */
function identity(text: string): string {
	return semanticInputHash(`${EMBEDDING_MODEL_ID}:${EMBEDDING_MODEL_REVISION}:preference-v1:${text}`);
}

/** Own a bounded SQLite cache for saved and draft refinement embeddings. */
export class SemanticPreferenceRepository {
	constructor(private readonly db: MoiraiDatabase) {}

	/** Enqueue missing preferences and read their preparation state in one bounded query. */
	catalog(texts: string[]): NonNullable<SemanticCatalog['preferences']> {
		const unique = [...new Set(texts.map((text) => text.trim()).filter(Boolean))];
		if (!unique.length) {
			return {};
		}
		const result: NonNullable<SemanticCatalog['preferences']> = Object.create(null);
		let queued = false;
		const rows = this.db.$client.prepare('SELECT * FROM semantic_preferences WHERE input_hash IN (SELECT value FROM json_each(?))')
			.all(JSON.stringify(unique.map(identity))) as Array<{ input_hash: string; embedding: Buffer | null; status: 'pending' | 'ready' | 'failed'; error_code: string | null }>;
		const byHash = new Map(rows.map((row) => [row.input_hash, row]));
		const queue = this.db.$client.prepare("INSERT INTO semantic_preferences(input_hash,input_text,status) VALUES (?,?,'pending') ON CONFLICT(input_hash) DO UPDATE SET status='pending',embedding=NULL");
		for (const text of unique) {
			const row = byHash.get(identity(text));
			let vector = row?.embedding?.length === EMBEDDING_DIMENSIONS * 4
				? Array.from({ length: EMBEDDING_DIMENSIONS }, (_, index) => row.embedding!.readFloatLE(index * 4)) : undefined;
			if (vector && (!vector.every(Number.isFinite) || Math.abs(vector.reduce((sum, value) => sum + value * value, 0) - 1) > 0.001)) {
				vector = undefined;
			}
			if (!row || (row.status === 'ready' && !vector)) {
				queue.run(identity(text), text);
				queued = true;
			}
			result[text] = vector && row?.status === 'ready' ? { status: 'ready', vector }
				: { status: row?.status === 'failed' ? 'failed' : 'pending', ...(row?.error_code ? { error: row.error_code } : {}) };
		}
		if (queued) {
			this.prune();
		}
		return result;
	}

	/** Explicitly retry only failed requested concepts, preserving cached ready vectors. */
	retryFailed(texts: string[]): number {
		return this.db.$client.prepare("UPDATE semantic_preferences SET status='pending',error_code=NULL,generated_at=NULL WHERE status='failed' AND input_hash IN (SELECT value FROM json_each(?))")
			.run(JSON.stringify([...new Set(texts.map((text) => text.trim()).filter(Boolean))].map(identity))).changes;
	}

	/** Reconcile saved prompts independently of whether an editor or scheduler reads them. */
	reconcile(): void {
		const saved = this.db.$client.prepare("SELECT config FROM scheduling_programs WHERE json_extract(config,'$.type') IN ('similarity','theme')").all() as Array<{ config: string }>;
		this.catalog(saved.flatMap((row) => refinementTexts(JSON.parse(row.config) as Extract<ProgramConfig, { type: 'similarity' | 'theme' }>)));
	}

	/** Keep retryable model setup problems visible without permanently failing prompts. */
	preparationError(message: string | null): void {
		this.db.$client.prepare("UPDATE semantic_preferences SET error_code=? WHERE status='pending'").run(message);
	}

	/** Read a bounded batch; drafts cannot create an unbounded in-memory inference queue. */
	pending(): Array<{ hash: string; text: string }> {
		return this.db.$client.prepare("SELECT input_hash AS hash,input_text AS text FROM semantic_preferences WHERE status='pending' LIMIT ?").all(PREFERENCE_BATCH_SIZE) as Array<{ hash: string; text: string }>;
	}

	/** Persist normalized output or a durable inference failure for this exact prompt identity. */
	store(hash: string, vector: number[] | null): void {
		let blob: Buffer | null = null;
		if (vector) {
			if (vector.length !== EMBEDDING_DIMENSIONS) {
				throw new Error('Unexpected preference embedding dimensions');
			}
			blob = Buffer.alloc(EMBEDDING_DIMENSIONS * 4);
			normalizeVector(vector).forEach((value, index) => blob!.writeFloatLE(value, index * 4));
		}
		this.db.$client.prepare('UPDATE semantic_preferences SET embedding=?,status=?,generated_at=? WHERE input_hash=?')
			.run(blob, vector ? 'ready' : 'failed', new Date().toISOString(), hash);
	}

	/** Retain saved preferences and a bounded recent draft cache, including pending drafts. */
	private prune(): void {
		this.db.$client.exec(`DELETE FROM semantic_preferences WHERE input_hash IN (
			SELECT input_hash FROM semantic_preferences WHERE input_text NOT IN (
				SELECT COALESCE(json_extract(config,'$.softPreferences'),'') FROM scheduling_programs
				WHERE json_extract(config,'$.type') IN ('similarity','theme')
				UNION SELECT j.value FROM scheduling_programs p, json_each(p.config,'$.hardExclusions') j
				WHERE json_extract(p.config,'$.type') IN ('similarity','theme')
				UNION SELECT json_extract(config,'$.theme') FROM scheduling_programs WHERE json_extract(config,'$.type')='theme'
			) ORDER BY rowid DESC LIMIT -1 OFFSET ${PREFERENCE_DRAFT_LIMIT})`);
	}
}
