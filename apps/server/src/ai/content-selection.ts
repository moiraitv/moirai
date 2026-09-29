import { AiInvalidSelectionError } from './errors.js';
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
/** Strict provider grammar for discovery; local validation still enforces lengths and limits. */
export const aiDiscoveryJsonSchema = { type: 'object', properties: {
	concepts: { type: 'array', items: { type: 'string' } },
	constraints: { type: 'array', items: { type: 'string' } },
	candidates: { type: 'array', items: { type: 'object', properties: {
		title: { type: 'string' }, year: { type: ['integer', 'null'] },
		series: { type: ['string', 'null'] }, seriesYear: { type: ['integer', 'null'] },
		season: { type: ['integer', 'null'] }, episode: { type: ['integer', 'null'] },
	}, required: ['title', 'year', 'series', 'seriesYear', 'season', 'episode'], additionalProperties: false } },
}, required: ['concepts', 'constraints', 'candidates'], additionalProperties: false };
/** Validated model plan; constraints are advisory and never override the authored prompt. */
export type AiDiscovery = z.infer<typeof aiDiscoverySchema>;
/** Keep the strongest planned concepts when a compatible model exceeds list limits. */
export function parseAiDiscovery(text: string): AiDiscovery {
	const value = parseAiJson(text, z.object({
		concepts: z.array(z.unknown()), constraints: z.array(z.unknown()), candidates: z.array(z.unknown()),
	}));
	const parsed = aiDiscoverySchema.safeParse({ concepts: value.concepts.slice(0, 6),
		constraints: value.constraints.slice(0, 12), candidates: value.candidates.slice(0, AI_DISCOVERY_ITEM_LIMIT) });
	if (!parsed.success) {
		throw new AiInvalidSelectionError('The AI service returned an invalid selection. Generate again.');
	}
	return parsed.data;
}
/** Form positive retrieval concepts locally when model planning is too slow to be useful. */
export function localDiscovery(prompt: string): AiDiscovery {
	const clauses = prompt.split(/[.!?]\s+/u).map(value => value.trim()).filter(Boolean);
	const positive = clauses.filter(value => !/^(?:no|not|avoid|exclude|without|don't|do not)\b/iu.test(value)).slice(0, 6);
	return { concepts: positive.length ? positive : [prompt.trim()], constraints: [], candidates: [] };
}
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
export function candidateBatches(items: AiCatalogItem[], itemLimit = AI_BATCH_ITEM_LIMIT): AiCandidate[][] {
	const batches: AiCandidate[][] = [];
	let batch: AiCandidate[] = [];
	let series = new Map<string, string>();
	let totalBytes = 0;
	let batchBytes = 0;
	for (const [index, item] of items.entries()) {
		const ref = String(index + 1);
		let encoded = candidateLine(item, ref, series);
		let bytes = Buffer.byteLength(encoded.line, 'utf8') + 1;
		if (batch.length >= itemLimit || batchBytes + bytes > AI_BATCH_BYTE_LIMIT) {
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

/** Find one complete top-level JSON object without mistaking quoted braces for structure. */
function singleJsonObject(text: string): string | null {
	let start = -1;
	let end = -1;
	let depth = 0;
	let quoted = false;
	let escaped = false;
	for (let index = 0; index < text.length; index += 1) {
		const char = text[index];
		if (depth === 0) {
			if (char === '{') {
				if (end >= 0) {
					return null;
				}
				start = index;
				depth = 1;
			}
			continue;
		}
		if (escaped) {
			escaped = false;
		}
		else if (char === '\\' && quoted) {
			escaped = true;
		}
		else if (char === '"') {
			quoted = !quoted;
		}
		else if (!quoted && char === '{') {
			depth += 1;
		}
		else if (!quoted && char === '}') {
			depth -= 1;
			if (depth === 0) {
				end = index + 1;
			}
		}
	}
	return start >= 0 && end >= 0 && depth === 0 ? text.slice(start, end) : null;
}

/** Validate a whole JSON response or one JSON object surrounded by provider prose. */
export function parseAiJson<T>(text: string, schema: z.ZodType<T>): T {
	try {
		return schema.parse(JSON.parse(text));
	}
	catch {
		const object = singleJsonObject(text);
		if (object) {
			try {
				return schema.parse(JSON.parse(object));
			}
			catch {
				// A prose wrapper cannot relax the expected selection schema.
			}
		}
		throw new AiInvalidSelectionError('The AI service returned an invalid selection. Generate again.');
	}
}
