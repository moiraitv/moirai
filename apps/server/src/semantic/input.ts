import { createHash } from 'node:crypto';

/** Version of the deliberate semantic text format, independent of technical scan fingerprints. */
export const SEMANTIC_INPUT_VERSION = 2;
/** Pinned model family used for all stored vectors. */
export const EMBEDDING_MODEL_ID = 'BAAI/bge-small-en-v1.5';
/** Immutable packaging identity; changing inference assets invalidates existing vectors. */
export const EMBEDDING_MODEL_REVISION = 'ea104dacec62c0de699686887e3f920caeb4f3e3-fp32-cls-v1';
/** BGE-small output width. */
export const EMBEDDING_DIMENSIONS = 384;

/** Minimal semantic metadata accepted from indexed items and their ancestors. */
export interface SemanticEntity {
	title: string;
	kind: string;
	plot: string | null;
	metadata: Record<string, unknown>;
	artists?: string[];
}

/** Canonicalize unordered semantic labels while preserving readable spelling. */
function labels(value: unknown): string {
	return Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === 'string')
		.map((item) => item.trim()).filter(Boolean))].sort().join(', ') : typeof value === 'string' ? value.trim() : '';
}

/** Build bounded descriptive text; paths, IDs, scheduling and technical fields never enter it. */
export function semanticInput(item: SemanticEntity, ancestors: SemanticEntity[] = []): string {
	const fields: Array<[string, string | null]> = [
		['Title', item.title], ['Type', item.kind],
		['Genres', labels(item.metadata.genres)], ['Keywords', labels(item.metadata.tags)],
		['Artists', labels(item.artists?.length ? item.artists : item.metadata.artists)],
		['Album', labels(item.metadata.album)],
	];
	fields.push(['Overview', item.plot]);
	for (const ancestor of ancestors.filter((entry) => ['show', 'artist', 'album'].includes(entry.kind)).slice(-3)) {
		fields.push([ancestor.kind, ancestor.title], ['Context', ancestor.plot], ['Genres', labels(ancestor.metadata.genres)]);
	}
	return fields.filter(([, value]) => value?.trim()).map(([label, value]) =>
		`${label}: ${value!.replace(/\s+/gu, ' ').trim().slice(0, label === 'Overview' ? 4_000 : label === 'Context' ? 1_000 : 500)}`).join('\n');
}

/** Hash the exact model input so unrelated metadata edits do not cause inference work. */
export function semanticInputHash(input: string): string {
	return createHash('sha256').update(input).digest('hex');
}
