import { AiSelectionError } from './errors.js';
import { z } from 'zod';

/** Candidate limits bound paid review, never the local library scan. */
export const AI_MOVIE_LIMIT = 1_000;
/** Episode identities require a broader shortlist. */
export const AI_EPISODE_LIMIT = 1_500;
/** Total compact candidate bytes across judging requests. */
export const AI_CATALOG_BYTE_LIMIT = 128 * 1024;
/** Per-request candidate bytes, leaving room for instructions and research. */
export const AI_BATCH_BYTE_LIMIT = 64 * 1024;
/** Maximum candidate identities judged together. */
export const AI_BATCH_ITEM_LIMIT = 500;
/** Maximum titles introduced by discovery before local identity resolution. */
export const AI_DISCOVERY_ITEM_LIMIT = 100;

/** Compact library identity plus local-only lexical metadata. */
export interface AiCatalogItem {
	id: string;
	title: string;
	year: number | null;
	kind: string;
	genres: string[];
	keywords?: string[];
	rating?: number | null;
	plot?: string | null;
	series?: string | null;
	seriesYear?: number | null;
	season?: number | null;
	episode?: number | null;
}

/** Bound untrusted discovery identities and positive retrieval concepts. */
export const aiDiscoverySchema = z.object({
	concepts: z.array(z.string().trim().min(1).max(300)).min(1).max(6),
	constraints: z.array(z.string().trim().min(1).max(300)).max(12),
	candidates: z.array(z.object({
		title: z.string().trim().min(1).max(500),
		year: z.number().int().nullable(),
		series: z.string().trim().min(1).max(500).nullable().optional(),
		seriesYear: z.number().int().nullable().optional(),
		season: z.number().int().nonnegative().nullable().optional(),
		episode: z.number().int().nonnegative().nullable().optional(),
	})).max(AI_DISCOVERY_ITEM_LIMIT),
});
/** Validated model plan; constraints are advisory and never override the authored prompt. */
export type AiDiscovery = z.infer<typeof aiDiscoverySchema>;
/** A compact, request-scoped identity and its original library item. */
export interface AiCandidate {
	ref: string;
	item: AiCatalogItem;
	line: string;
}

/** Encode episode references using one series declaration per judging batch. */
function candidateLine(item: AiCatalogItem, ref: string, series: Map<string, string>): { line: string; seriesKey?: string; seriesRef?: string } {
	const base = [ref, item.title, item.year, item.kind, item.genres];
	const rating = item.rating != null ? [item.rating] : [];
	if (item.kind !== 'episode') {
		return { line: JSON.stringify([...base, ...rating]) };
	}
	const seriesKey = JSON.stringify([item.series ?? null, item.seriesYear ?? null]);
	const seriesRef = series.get(seriesKey) ?? `s${series.size + 1}`;
	const declaration = series.has(seriesKey) ? '' : `${JSON.stringify(['series', seriesRef, item.series ?? null, item.seriesYear ?? null])}\n`;
	return { line: declaration + JSON.stringify([...base, seriesRef, item.season ?? null, item.episode ?? null, ...rating]), seriesKey, seriesRef };
}

/** Prepare complete UTF-8 rows, accounting for per-batch series declarations in both budgets. */
export function candidateBatches(items: AiCatalogItem[]): AiCandidate[][] {
	const batches: AiCandidate[][] = [];
	let batch: AiCandidate[] = [];
	let series = new Map<string, string>();
	let totalBytes = 0;
	let batchBytes = 0;
	for (const [index, item] of items.entries()) {
		const ref = String(index + 1);
		let encoded = candidateLine(item, ref, series);
		let bytes = Buffer.byteLength(encoded.line, 'utf8') + 1;
		if (batch.length >= AI_BATCH_ITEM_LIMIT || batchBytes + bytes > AI_BATCH_BYTE_LIMIT) {
			if (batch.length) {
				batches.push(batch);
			}
			batch = [];
			batchBytes = 0;
			series = new Map();
			encoded = candidateLine(item, ref, series);
			bytes = Buffer.byteLength(encoded.line, 'utf8') + 1;
		}
		if (bytes > AI_BATCH_BYTE_LIMIT || totalBytes + bytes > AI_CATALOG_BYTE_LIMIT) {
			continue;
		}
		if (encoded.seriesKey && encoded.seriesRef) {
			series.set(encoded.seriesKey, encoded.seriesRef);
		}
		batch.push({ ref, item, line: encoded.line });
		totalBytes += bytes;
		batchBytes += bytes;
	}
	if (batch.length) {
		batches.push(batch);
	}
	return batches;
}

/** Reject malformed model data without echoing provider content into public errors. */
export function parseAiJson<T>(text: string, schema: z.ZodType<T>): T {
	try {
		return schema.parse(JSON.parse(text));
	}
	catch {
		throw new AiSelectionError('The AI service returned an invalid selection. Generate again.');
	}
}
