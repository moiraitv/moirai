import { z } from 'zod';
import { aiResultOfferLimit } from '@moirai/shared';
import type { AppConfig } from '../config.js';
import { AiInvalidSelectionError, AiSelectionError, aiFailureCategory, type AiFailureCategory } from './errors.js';
import { candidateBatches, parseAiJson, type AiCandidate, type AiCatalogItem } from './content-selection.js';
import { requestAiSelectionText, type AiRequestActivity, type AiRequestUsage } from './provider.js';

/** Stop launching reviews early enough to reserve time for a final quality pass. */
const REVIEW_LAUNCH_LIMIT_MS = 210_000;
/** In-flight reviews end before the final pass's reserved time. */
const REVIEW_END_LIMIT_MS = 255_000;
/** Allow slow review replies while the shared review cutoff still protects the final pass. */
const REVIEW_REQUEST_LIMIT_MS = 60_000;
/** Keep final refinement within its reserved time. */
const FINAL_REQUEST_LIMIT_MS = 45_000;
/** Give one simplified rescue enough time while reserving the final pass. */
const RESCUE_REQUEST_LIMIT_MS = 35_000;
/** Reduce candidate complexity for the single invalid-response rescue. */
const RESCUE_CANDIDATE_LIMIT = 80;

/** Ranked direct and adjacent matches from one review or final pass. */
const tierReferenceSchema = z.union([z.string().min(1), z.object({ reference: z.string().min(1) })]);
/** Some compatible models echo candidate details beside otherwise valid references. */
const tiersSchema = z.object({ core: z.array(tierReferenceSchema), supporting: z.array(tierReferenceSchema) });
/** Native Claude grammar for the two required reference lists. */
const tiersJsonSchema = { type: 'object', properties: {
	core: { type: 'array', items: { type: 'string' } },
	supporting: { type: 'array', items: { type: 'string' } },
}, required: ['core', 'supporting'], additionalProperties: false };

/** Inputs for bounded non-search review and optional final refinement. */
export interface FastReviewOptions {
	ai: NonNullable<AppConfig['ai']>;
	prompt: string;
	constraints: string[];
	batches: AiCandidate[][];
	maxResults: number;
	started: number;
	signal: AbortSignal;
	userSignal?: AbortSignal;
	fetchImpl?: typeof fetch;
	requestOptions?: Pick<AiRequestActivity, 'maxCompletionTokens' | 'reasoningEffort' | 'disableThinking' | 'provider' | 'protocol' | 'chatJsonMode'>;
	onProgress?: AiRequestActivity['onProgress'];
	onRequest: (phase: 'review' | 'final', batch?: number) => void;
	onUsage: (usage: AiRequestUsage, phase: 'review' | 'final', batch?: number) => void;
	onDiagnostic?: (value: { phase: 'review' | 'final'; batch?: number; durationMs: number;
		outcome: 'completed' | 'failed'; category?: AiFailureCategory }) => void;
	onFatalUsage: () => AiSelectionError | undefined;
}

/** Reject unknown references while deduplicating repeated references in ranked order. */
function tieredMatches(value: z.infer<typeof tiersSchema>, candidates: AiCandidate[]): { core: AiCatalogItem[]; supporting: AiCatalogItem[] } {
	const byRef = new Map(candidates.map(row => [row.ref, row.item]));
	const seen = new Set<string>();
	const collect = (refs: Array<z.infer<typeof tierReferenceSchema>>): AiCatalogItem[] => refs.flatMap(value => {
		const ref = typeof value === 'string' ? value : value.reference;
		const item = byRef.get(ref);
		if (!item) {
			throw new AiInvalidSelectionError('The AI service returned an unknown candidate. Generate again.');
		}
		if (seen.has(ref)) {
			return [];
		}
		seen.add(ref);
		return [item];
	});
	return { core: collect(value.core), supporting: collect(value.supporting) };
}

/** Rotate through batches so one overinclusive review cannot crowd out later batches. */
function rotateBatches(lists: AiCatalogItem[][], limit: number): AiCatalogItem[] {
	const result: AiCatalogItem[] = [];
	for (let rank = 0; result.length < limit && lists.some(list => rank < list.length); rank += 1) {
		for (const list of lists) {
			if (list[rank] && result.length < limit) {
				result.push(list[rank]!);
			}
		}
	}
	return result;
}

/** Preserve modest overages while limiting adjacent picks to the number of core picks. */
function limitedSelection(core: AiCatalogItem[], supporting: AiCatalogItem[], target: number): { itemIds: string[]; coreItemIds: string[]; supportingItemIds: string[] } {
	const offerLimit = aiResultOfferLimit(target);
	const coreItemIds = core.slice(0, offerLimit).map(item => item.id);
	const supportingItemIds = supporting.slice(0, Math.min(coreItemIds.length, offerLimit - coreItemIds.length)).map(item => item.id);
	return { itemIds: [...coreItemIds, ...supportingItemIds], coreItemIds, supportingItemIds };
}

/** Review compact batches and optionally refine their validated selections. */
export async function runFastLocalReview(options: FastReviewOptions): Promise<{ itemIds: string[]; coreItemIds: string[]; supportingItemIds: string[]; reviewedCount: number; reviewStoppedEarly: boolean; finalReviewIncomplete: boolean }> {
	const { ai, prompt, constraints, batches, maxResults, started, signal, userSignal } = options;
	const completed: Array<{ core: AiCatalogItem[]; supporting: AiCatalogItem[] } | undefined> = Array(batches.length).fill(undefined);
	let reviewedCount = 0;
	let reviewStoppedEarly = false;
	let firstFailure: unknown;
	let invalidResponses = 0;
	let rescueUsed = false;

	// Launch pairs until the review cutoff, retaining valid batches in candidate order.
	for (let offset = 0; offset < batches.length; offset += 2) {
		if (signal.aborted || Date.now() - started >= REVIEW_LAUNCH_LIMIT_MS) {
			reviewStoppedEarly = true;
			break;
		}
		const indices = [offset, offset + 1].filter(index => index < batches.length);
		const results = await Promise.allSettled(indices.map(async index => {
			const requestStarted = Date.now();
			try {
				const batch = batches[index]!;
				const details = { batch: index + 1, totalBatches: batches.length };
				const remaining = REVIEW_END_LIMIT_MS - (Date.now() - started);
				if (remaining <= 0) {
					throw new AiSelectionError('Review time expired before this batch started.');
				}
				options.onProgress?.('reviewing', details);
				options.onRequest('review', index + 1);
				const text = await requestAiSelectionText(ai, [
					{ role: 'system', content: 'Review only the supplied works against the original description. Core means the defining theme, event or feature is prominent in the actual plot or setting; a shared genre or conventional seasonal viewing association is not core. Put clearly permitted adjacent picks in supporting, but keep them limited. Exclude uncertain or weak matches. Apply exclusions and preferences, and never fill a quota. Return exactly one JSON object with ranked core and supporting arrays of reference strings only, without candidate details.' },
					{ role: 'user', content: `${JSON.stringify({ description: prompt, constraints })}\nRows: [reference,title,year,type,genres,rating?] or [reference,title,year,type,genres,seriesRef,season,episode,rating?]. Series declarations: ["series",seriesRef,title,year].\n${batch.map(row => row.line).join('\n')}` },
				], options.fetchImpl, { ...options.requestOptions, jsonSchema: tiersJsonSchema,
					signal: AbortSignal.any([signal, AbortSignal.timeout(Math.min(REVIEW_REQUEST_LIMIT_MS, remaining))]),
					onUsage: usage => options.onUsage(usage, 'review', index + 1),
					onProgress: () => options.onProgress?.('reviewing', details) });
				const matches = tieredMatches(parseAiJson(text, tiersSchema), batch);
				options.onDiagnostic?.({ phase: 'review', batch: index + 1, durationMs: Date.now() - requestStarted,
					outcome: 'completed' });
				return matches;
			}
			catch (cause) {
				options.onDiagnostic?.({ phase: 'review', batch: index + 1, durationMs: Date.now() - requestStarted,
					outcome: 'failed', category: aiFailureCategory(cause) });
				throw cause;
			}
		}));
		const fatalUsageError = options.onFatalUsage();
		if (fatalUsageError) {
			throw fatalUsageError;
		}
		for (const [position, result] of results.entries()) {
			if (result.status === 'rejected') {
				reviewStoppedEarly = true;
				firstFailure ??= result.reason;
				if (result.reason instanceof AiInvalidSelectionError) {
					invalidResponses += 1;
				}
				continue;
			}
			completed[indices[position]!] = result.value;
			reviewedCount += batches[indices[position]!]!.length;
		}
		// A smaller, unambiguous request can recover the leading candidates before later batches.
		if (!rescueUsed && invalidResponses >= 2 && !completed.some(Boolean)
			&& Date.now() - started < REVIEW_LAUNCH_LIMIT_MS
			&& REVIEW_END_LIMIT_MS - (Date.now() - started) >= RESCUE_REQUEST_LIMIT_MS) {
			rescueUsed = true;
			const rescue = batches.flat().slice(0, RESCUE_CANDIDATE_LIMIT);
			const requestStarted = Date.now();
			try {
				options.onProgress?.('reviewing');
				options.onRequest('review');
				const text = await requestAiSelectionText(ai, [
					{ role: 'system', content: 'Select only clearly fitting items from these library rows. Apply the original description and exclusions. Put direct theme matches in core and a limited number of closely related picks in supporting. Use only listed reference strings. Return exactly one JSON object with core and supporting arrays; empty arrays are valid.' },
					{ role: 'user', content: `${JSON.stringify({ description: prompt, constraints })}\nRows: [reference,title,year,type,genres,rating?].\n${rescue.map(row => row.line).join('\n')}` },
				], options.fetchImpl, { ...options.requestOptions, jsonSchema: tiersJsonSchema,
					signal: AbortSignal.any([signal, AbortSignal.timeout(RESCUE_REQUEST_LIMIT_MS)]),
					onUsage: usage => options.onUsage(usage, 'review'),
					onProgress: () => options.onProgress?.('reviewing') });
				completed[0] = tieredMatches(parseAiJson(text, tiersSchema), rescue);
				reviewedCount += rescue.length;
				options.onDiagnostic?.({ phase: 'review', durationMs: Date.now() - requestStarted, outcome: 'completed' });
			}
			catch (cause) {
				options.onDiagnostic?.({ phase: 'review', durationMs: Date.now() - requestStarted,
					outcome: 'failed', category: aiFailureCategory(cause) });
				firstFailure ??= cause;
			}
			const fatalUsageError = options.onFatalUsage();
			if (fatalUsageError) {
				throw fatalUsageError;
			}
		}
	}
	if (userSignal?.aborted) {
		signal.throwIfAborted();
	}
	if (!completed.some(Boolean)) {
		throw firstFailure ?? new AiSelectionError('Review stopped before any batch completed. Generate again.');
	}
	const poolLimit = Math.min(300, Math.max(100, Math.ceil(maxResults * 1.5)));
	const coreLists = completed.map(result => result?.core ?? []);
	const supportingLists = completed.map(result => result?.supporting ?? []);
	const core = rotateBatches(coreLists, Math.ceil(poolLimit * 0.75));
	const supporting = rotateBatches(supportingLists, poolLimit - core.length);
	core.push(...rotateBatches(coreLists.map(list => list.filter(item => !core.some(value => value.id === item.id))), poolLimit - core.length - supporting.length));
	const selected = [...core, ...supporting];
	const fallback = limitedSelection(core, supporting, maxResults);
	if (!selected.length) {
		return { itemIds: [], coreItemIds: [], supportingItemIds: [], reviewedCount, reviewStoppedEarly, finalReviewIncomplete: false };
	}

	// Reassign references and verify the cross-batch selection before publication.
	try {
		const requestStarted = Date.now();
		try {
			signal.throwIfAborted();
			const finalBatches = candidateBatches(selected, selected.length);
			if (finalBatches.length !== 1 || finalBatches[0]!.length !== selected.length) {
				throw new AiSelectionError('The final selection exceeded the candidate budget. Generate again.');
			}
			const finalBatch = finalBatches[0]!;
			const priorCore = finalBatch.filter(row => core.some(item => item.id === row.item.id)).map(row => row.ref);
			options.onProgress?.('generating');
			options.onRequest('final');
			const text = await requestAiSelectionText(ai, [
				{ role: 'system', content: 'Make the final selection from these previously nominated works. Reassess every work against the original description; the first-pass tiers are advisory, not proof. Core requires the defining theme, event or feature to be prominent in the actual plot or setting. Genre alone and conventional seasonal viewing are never core. Supporting requires a clear permitted adjacent fit, and must remain limited when the prompt says so. Remove weak or uncertain works. The requested count is a target; fewer strong matches or a modest overage are acceptable. Return exactly one JSON object with ranked core and supporting arrays of reference strings only.' },
				{ role: 'user', content: `${JSON.stringify({ description: prompt, constraints, target: maxResults, priorCore })}\nRows: [reference,title,year,type,genres,rating?] or [reference,title,year,type,genres,seriesRef,season,episode,rating?]. Series declarations: ["series",seriesRef,title,year].\n${finalBatch.map(row => row.line).join('\n')}` },
			], options.fetchImpl, { ...options.requestOptions, jsonSchema: tiersJsonSchema,
				signal: AbortSignal.any([signal, AbortSignal.timeout(FINAL_REQUEST_LIMIT_MS)]),
				onUsage: usage => options.onUsage(usage, 'final'),
				onProgress: () => options.onProgress?.('generating') });
			const fatalUsageError = options.onFatalUsage();
			if (fatalUsageError) {
				throw fatalUsageError;
			}
			const final = tieredMatches(parseAiJson(text, tiersSchema), finalBatch);
			if (userSignal?.aborted) {
				signal.throwIfAborted();
			}
			options.onDiagnostic?.({ phase: 'final', durationMs: Date.now() - requestStarted, outcome: 'completed' });
			return { ...limitedSelection(final.core, final.supporting, maxResults), reviewedCount,
				reviewStoppedEarly, finalReviewIncomplete: false };
		}
		catch (cause) {
			options.onDiagnostic?.({ phase: 'final', durationMs: Date.now() - requestStarted,
				outcome: 'failed', category: aiFailureCategory(cause) });
			throw cause;
		}
	}
	catch {
		if (userSignal?.aborted) {
			signal.throwIfAborted();
		}
		const fatalUsageError = options.onFatalUsage();
		if (fatalUsageError) {
			throw fatalUsageError;
		}
		return { ...fallback, reviewedCount, reviewStoppedEarly, finalReviewIncomplete: true };
	}
}
