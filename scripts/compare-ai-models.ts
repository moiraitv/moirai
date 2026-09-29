import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { env, pipeline } from '@huggingface/transformers';
import { AI_DEFAULT_RESULT_COUNT, aiResultCountSchema } from '@moirai/shared';
import { z } from 'zod';
import { generateAiSelection, type AiGenerationMetrics } from '../apps/server/src/ai/pipeline.js';
import { readAiCatalog } from '../apps/server/src/repository/ai-catalog.js';
import { SemanticRepository } from '../apps/server/src/repository/semantic.js';
import { loadConfig, type AppConfig } from '../apps/server/src/config.js';
import { AiSelectionError } from '../apps/server/src/ai/errors.js';
import type { AiRequestActivity } from '../apps/server/src/ai/provider.js';
import * as schema from '../apps/server/src/db/schema.js';
import * as semanticSchema from '../apps/server/src/db/semantic-schema.js';
import { createDiagnosticDirectory, diagnosticFetch, diagnosticPhases, writeDiagnosticJson, type DiagnosticPhase } from './ai-comparison-diagnostics.js';
import { EvaluationBudget, EvaluationBudgetError, evaluationOptions, evaluationUsesLocalDiscovery } from './ai-evaluation.js';

/** Give each diagnostic generation fifteen minutes without changing production limits. */
const DIAGNOSTIC_TIMEOUT_MS = 15 * 60_000;

/** Keep every model's four provider settings explicit while allowing a display name. */
export const comparisonModelSchema = z.object({
	name: z.string().trim().min(1).optional(),
	apiKey: z.string().trim().min(1),
	baseUrl: z.url(),
	model: z.string().trim().min(1),
	webSearch: z.boolean(),
	chatJsonMode: z.enum(['json_object', 'json_schema', 'prompt_only']).optional(),
	apiProtocol: z.enum(['chat-completions', 'anthropic-messages']).optional(),
});

/** One prompt, library, and result ceiling shared by every provider configuration. */
export const comparisonSchema = z.object({
	databasePath: z.string().trim().min(1).optional(),
	libraryId: z.uuid(),
	prompt: z.string().trim().min(1).max(2_000),
	maxResults: aiResultCountSchema.default(AI_DEFAULT_RESULT_COUNT),
	models: z.array(comparisonModelSchema).min(1),
});

/** Resolve env:NAME without copying credentials into reports or errors. */
export function configuredModel(value: z.infer<typeof comparisonModelSchema>, environment: NodeJS.ProcessEnv = process.env): NonNullable<AppConfig['ai']> {
	const name = value.apiKey.startsWith('env:') ? value.apiKey.slice(4) : null;
	const apiKey = name ? environment[name] : value.apiKey;
	if (!apiKey?.trim()) {
		throw new Error(name ? `Missing API key environment variable ${name}.` : 'Missing API key.');
	}
	return { apiKey: apiKey.trim(), baseUrl: value.baseUrl.replace(/\/+$/u, ''), model: value.model, webSearch: value.webSearch };
}

/** Provider request options shared by ordinary comparisons and evaluations. */
type ComparisonRequestOptions = Pick<AiRequestActivity,
	'maxCompletionTokens' | 'reasoningEffort' | 'disableThinking' | 'provider' | 'protocol' | 'chatJsonMode'>;

/** Apply explicitly configured API options in both ordinary comparisons and evaluations. */
export function comparisonRequestOptions(value: z.infer<typeof comparisonModelSchema>, evaluate: boolean): ComparisonRequestOptions {
	return { ...(evaluate ? evaluationOptions(value.model, value.baseUrl) : {}),
		...(value.apiProtocol ? { protocol: value.apiProtocol } : {}),
		...(value.chatJsonMode ? { chatJsonMode: value.chatJsonMode } : {}) };
}

/** Resolve relative database paths from the configuration file, or use the development setting. */
function databasePath(value: string | undefined, configPath: string | undefined): string {
	if (!value) {
		return loadConfig({ ai: null }).databasePath;
	}
	return isAbsolute(value) ? value : resolve(configPath ? dirname(configPath) : process.cwd(), value);
}

/** Show library identifiers without starting inference or a paid request. */
function listLibraries(sqlite: Database.Database): void {
	const rows = sqlite.prepare(`SELECT l.id, l.name, l.type_key AS typeKey, COUNT(i.id) AS items
		FROM libraries l LEFT JOIN media_items i ON i.library_id=l.id
		GROUP BY l.id ORDER BY l.name`).all();
	console.table(rows);
}

/** Fail before paid work if a report would overwrite a file or cannot be created. */
async function checkOutputPath(outputPath: string | undefined): Promise<void> {
	if (!outputPath) {
		return;
	}
	await access(dirname(resolve(outputPath)), constants.W_OK);
	try {
		await access(outputPath);
	}
	catch (cause) {
		if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
			return;
		}
		throw cause;
	}
	throw new Error(`Output file already exists: ${outputPath}`);
}

/** Report successful selections and failures without including credentials or provider bodies. */
export interface ComparisonRow {
	name: string;
	round?: number;
	model: string;
	webSearch: boolean;
	status: 'completed' | 'failed';
	count: number;
	durationMs: number;
	requests: number;
	reportedSearchCalls: number;
	inputTokens: number | null;
	outputTokens: number | null;
	reviewedCount: number | null;
	libraryCount: number;
	mediaEmbeddingsAvailable: boolean;
	partial?: boolean;
	finalReviewIncomplete?: boolean;
	localDiscoveryFallback?: boolean;
	failurePhase?: string;
	failureCategory?: string;
	estimatedCostUsd?: number;
	phases?: DiagnosticPhase[];
	validation?: 'valid' | 'partial' | 'failed';
	items: Array<{ id: string; title: string; year: number | null; kind: string; series?: string | null;
		season?: number | null; episode?: number | null; rating?: number | null }>;
	error?: string;
}

/** A brief provider check performed before any full library review begins. */
export interface ModelPreflight {
	name: string;
	status: 'ready' | 'failed';
	issue?: string;
}

/** A named model whose key has already been resolved from its configuration. */
export interface PreflightProvider {
	name: string;
	ai: NonNullable<AppConfig['ai']>;
	chatJsonMode?: 'json_object' | 'json_schema' | 'prompt_only';
	requestOptions?: Pick<AiRequestActivity, 'maxCompletionTokens' | 'reasoningEffort' | 'disableThinking' | 'provider' | 'protocol'>;
}

/** Check the configured protocol, key, and model with a small bounded request. */
async function probeModel(
	ai: NonNullable<AppConfig['ai']>, 
	chatJsonMode: PreflightProvider['chatJsonMode'],
	requestOptions: PreflightProvider['requestOptions'], 
	fetchImpl: typeof fetch,
): Promise<string | null> {
	const search = ai.webSearch;
	const anthropic = requestOptions?.protocol === 'anthropic-messages';
	const body = anthropic
		? { model: ai.model, system: 'Reply with JSON.', messages: [{ role: 'user', content: 'Return {"ok":true}.' }],
			max_tokens: 256, thinking: { type: 'disabled' },
			output_config: { format: { type: 'json_schema', schema: { type: 'object',
				properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false } } } }
		: search
			? { model: ai.model, input: [{ role: 'user', content: 'Reply briefly.' }], max_output_tokens: 32, store: false }
			: { model: ai.model, messages: [{ role: 'system', content: 'Reply with JSON.' },
				{ role: 'user', content: 'Return {"ok":true}.' }],
			...(chatJsonMode === 'prompt_only' ? {} : chatJsonMode === 'json_schema'
				? { response_format: { type: 'json_schema', json_schema: { name: 'moirai_preflight', strict: true,
					schema: { type: 'object', properties: { ok: { type: 'boolean' } },
						required: ['ok'], additionalProperties: false } } } }
				: { response_format: { type: 'json_object' } }),
			max_completion_tokens: requestOptions?.maxCompletionTokens ? 256 : 32,
			...(requestOptions?.reasoningEffort ? { reasoning_effort: requestOptions.reasoningEffort } : {}),
			...(requestOptions?.disableThinking ? { thinking: { type: 'disabled' } } : {}),
			...(requestOptions?.provider ? { provider: requestOptions.provider } : {}) };
	try {
		const response = await fetchImpl(`${ai.baseUrl}/${anthropic ? 'messages' : search ? 'responses' : 'chat/completions'}`, {
			method: 'POST', headers: anthropic ? { 'x-api-key': ai.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }
				: { authorization: `Bearer ${ai.apiKey}`, 'content-type': 'application/json' },
			body: JSON.stringify(body), signal: AbortSignal.timeout(30_000),
		});
		if (!response.ok) {
			await response.body?.cancel();
			return `HTTP ${response.status}`;
		}
		const payload: unknown = await response.json();
		const native = anthropic
			? z.object({ stop_reason: z.literal('end_turn'), content: z.array(z.object({ type: z.literal('text'), text: z.string() })).min(1) }).safeParse(payload)
			: null;
		const valid = native
			? native.success && native.data.content.some(part => z.object({ ok: z.literal(true) }).safeParse(JSON.parse(part.text)).success)
			: search
				? z.object({ output: z.array(z.unknown()) }).safeParse(payload).success
				: requestOptions ? z.object({ choices: z.array(z.object({ message: z.object({ content: z.string().min(1) }),
					finish_reason: z.literal('stop') })).min(1) }).safeParse(payload).success
					: z.object({ choices: z.array(z.unknown()).min(1) }).safeParse(payload).success;
		return valid ? null : 'Unexpected response format';
	}
	catch (cause) {
		if (cause instanceof EvaluationBudgetError) {
			return cause.message;
		}
		return 'Connection, timeout, or invalid JSON response';
	}
}

/** Check every provider and return only safe status details for the terminal. */
export async function preflightProviders(models: PreflightProvider[], fetchImpl: typeof fetch = fetch): Promise<ModelPreflight[]> {
	const checks: ModelPreflight[] = [];
	for (const { name, ai, chatJsonMode, requestOptions } of models) {
		const issue = await probeModel(ai, chatJsonMode, requestOptions, fetchImpl);
		checks.push(issue ? { name, status: 'failed', issue } : { name, status: 'ready' });
	}
	return checks;
}

/** Omit unsupported JSON mode while retaining the pipeline's JSON instructions and parsing. */
export function promptOnlyFetch(fetchImpl: typeof fetch = fetch): typeof fetch {
	return ((input: RequestInfo | URL, init?: RequestInit) => {
		if (typeof init?.body !== 'string') {
			return fetchImpl(input, init);
		}
		const body = JSON.parse(init.body) as Record<string, unknown>;
		if (!('response_format' in body)) {
			return fetchImpl(input, init);
		}
		delete body.response_format;
		return fetchImpl(input, { ...init, body: JSON.stringify(body) });
	}) as typeof fetch;
}

/** Pairwise overlap reveals disagreements without treating agreement as a quality score. */
export function overlap(rows: ComparisonRow[]): Array<{ models: string; shared: number; union: number }> {
	const completed = rows.filter(row => row.status === 'completed');
	const pairs: Array<{ models: string; shared: number; union: number }> = [];
	for (let left = 0; left < completed.length; left += 1) {
		for (let right = left + 1; right < completed.length; right += 1) {
			const first = new Set(completed[left]!.items.map(item => item.id));
			const second = new Set(completed[right]!.items.map(item => item.id));
			pairs.push({ models: `${completed[left]!.name} / ${completed[right]!.name}`,
				shared: [...first].filter(id => second.has(id)).length, union: new Set([...first, ...second]).size });
		}
	}
	return pairs;
}

/** Run the production selection pipeline against a read-only development catalog. */
async function compare(
	configPath: string, 
	outputPath?: string, 
	diagnose = false, 
	evaluate = false,
	spendingLimitUsd = 10, 
	onlyModels?: Set<string>,
	pilot = false,
	reliability = false,
	single = false,
	promptOverride?: string,
	jsonSchemaModels?: Set<string>,
): Promise<void> {
	await checkOutputPath(outputPath);
	const config = comparisonSchema.parse(JSON.parse(await readFile(configPath, 'utf8')));
	const prompt = promptOverride ?? config.prompt;
	const configured = config.models.map(value => jsonSchemaModels?.has(value.model) ? { ...value, chatJsonMode: 'json_schema' as const } : value);
	const models = onlyModels ? configured.filter(value => onlyModels.has(value.model)) : configured;
	if (!models.length) {
		throw new Error('No configured models match --only.');
	}
	const names = models.map(value => value.name ?? value.model);
	if (new Set(names).size !== names.length) {
		throw new Error('Give each model configuration a unique name.');
	}
	const credentialIssues: string[] = [];
	const resolved = models.flatMap(model => {
		try {
			return [{ value: model, ai: configuredModel(model) }];
		}
		catch (cause) {
			credentialIssues.push(`${model.name ?? model.model}: ${cause instanceof Error ? cause.message : 'Missing API key.'}`);
			return [];
		}
	});
	if (credentialIssues.length) {
		throw new Error(`Credential configuration failed:\n${credentialIssues.join('\n')}`);
	}
	const path = databasePath(config.databasePath, configPath);
	const sqlite = new Database(path, { readonly: true, fileMustExist: true });
	try {
		const db = drizzle(sqlite, { schema: { ...schema, ...semanticSchema } });
		const library = sqlite.prepare('SELECT name, type_key AS typeKey FROM libraries WHERE id=?').get(config.libraryId) as { name: string; typeKey: string } | undefined;
		if (!library) {
			throw new Error(`Library ${config.libraryId} was not found in ${path}. Use --list-libraries to inspect this database.`);
		}
		const catalog = await readAiCatalog(db, config.libraryId);
		if (!catalog.length) {
			throw new Error(`Library ${library.name} has no indexed items.`);
		}
		const vectors = new SemanticRepository(db).retrievalVectors(config.libraryId);
		console.log(`Library: ${library.name} (${catalog.length} items, ${Object.keys(vectors).length} cached media embeddings)`);
		console.log(`Maximum results: ${config.maxResults}`);

		env.allowRemoteModels = false;
		env.useFSCache = false;
		const extractor = await pipeline('feature-extraction', resolve('apps/server/dist/embedding-model'), {
			device: 'cpu', dtype: 'fp32', local_files_only: true,
			session_options: { intraOpNumThreads: 1, interOpNumThreads: 1, executionMode: 'sequential' },
		});
		try {
			console.log('Checking provider credentials and model access...');
			const budget = evaluate ? new EvaluationBudget(
				reliability ? 30 : 10,
				join(dirname(configPath), reliability ? 'ai-reliability-v1-budget.json' : 'ai-evaluation-v2-budget.json'),
				spendingLimitUsd,
			) : undefined;
			const upstream = budget ? budget.fetch() : fetch;
			const checks = await preflightProviders(resolved.map(({ value, ai }) => {
				const requestOptions = comparisonRequestOptions(value, evaluate);
				return { name: value.name ?? value.model, ai,
					...(value.chatJsonMode ? { chatJsonMode: value.chatJsonMode } : {}),
					...(Object.keys(requestOptions).length ? { requestOptions } : {}) };
			}), upstream);
			console.table(checks);
			if (checks.some(check => check.status === 'failed')) {
				throw new Error('Preflight failed; no full generations started.');
			}

			const diagnosticDirectory = diagnose || evaluate ? await createDiagnosticDirectory(configPath) : undefined;
			if (diagnosticDirectory) {
				await writeDiagnosticJson(join(diagnosticDirectory, 'manifest.json'), {
					startedAt: new Date().toISOString(), libraryId: config.libraryId, libraryCount: catalog.length,
					promptHash: createHash('sha256').update(prompt).digest('hex'), maxResults: config.maxResults,
					timeoutMs: evaluate ? 300_000 : DIAGNOSTIC_TIMEOUT_MS, pilot,
					...(budget ? { spendingLimitUsd: budget.limitUsd } : {}),
					models: resolved.map(({ value }) => ({ name: value.name ?? value.model,
						model: value.model, webSearch: value.webSearch, chatJsonMode: value.chatJsonMode ?? 'json_object',
						apiProtocol: value.apiProtocol ?? 'chat-completions' })),
				});
				console.log(`Diagnostic files: ${diagnosticDirectory}`);
			}
			const credentials = resolved.map(({ ai }) => ai.apiKey);
			const queries = new Map<string, number[]>();
			const byId = new Map(catalog.map(item => [item.id, item]));
			const rows: ComparisonRow[] = [];
			const runQueue = reliability && !pilot && !single
				? [1, 2].flatMap(round => resolved.map(entry => ({ ...entry, round })))
				: resolved.map(entry => ({ ...entry, round: 1 }));
			for (const [index, { value, ai, round }] of runQueue.entries()) {
				const name = value.name ?? value.model;
				const modelDirectory = diagnosticDirectory ? join(diagnosticDirectory, `model-${String(index + 1).padStart(2, '0')}`) : undefined;
				if (modelDirectory) {
					await mkdir(modelDirectory, { mode: 0o700 });
				}
				let phase = 'preparing';
				const capture = modelDirectory ? diagnosticFetch(modelDirectory, credentials, () => phase, upstream) : upstream;
				const requestFetch = value.chatJsonMode === 'prompt_only' ? promptOnlyFetch(capture) : capture;
				const requestOptions = comparisonRequestOptions(value, evaluate);
				let metrics: AiGenerationMetrics | undefined;
				const started = Date.now();
				const budgetBefore = budget?.usedUsd ?? 0;
				console.log(`\nRunning ${name}${evaluate ? ` (round ${round})` : ''}...`);
				try {
					const result = await generateAiSelection(ai, prompt, library.typeKey, {
						fetchImpl: requestFetch,
						...(diagnose ? { timeoutMs: DIAGNOSTIC_TIMEOUT_MS } : {}),
						...(Object.keys(requestOptions).length ? { requestOptions } : {}),
						...(evaluate ? { fastLocalReview: true,
							localDiscovery: !reliability && evaluationUsesLocalDiscovery(value.model),
							...(pilot ? { evaluationCandidateLimit: 125 } : {}) } : {}),
						loadCatalog: async () => catalog,
						loadVectors: async concepts => {
							for (const concept of concepts) {
								if (!queries.has(concept)) {
									queries.set(concept, Array.from((await extractor(concept, { pooling: 'cls', normalize: true })).data));
								}
							}
							return { vectors, queries: concepts.map(concept => queries.get(concept)!),
								available: Object.keys(vectors).length === catalog.length };
						},
						onMetrics: value => {
							metrics = value;
						},
					}, { onProgress: (status, details) => {
						phase = details?.batch ? `${status} batch ${details.batch}/${details.totalBatches}` : status;
					} }, config.maxResults);
					rows.push({ name, ...(evaluate ? { round,
						partial: result.coverage?.reviewStoppedEarly === true || result.coverage?.finalReviewIncomplete === true,
						finalReviewIncomplete: result.coverage?.finalReviewIncomplete === true,
						localDiscoveryFallback: result.coverage?.localDiscoveryFallback === true,
						estimatedCostUsd: (budget?.usedUsd ?? 0) - budgetBefore } : {}),
					model: value.model, webSearch: value.webSearch, status: 'completed',
					count: result.itemIds.length, durationMs: Date.now() - started, requests: metrics?.requests ?? 0,
					reportedSearchCalls: metrics?.toolCalls ?? 0, inputTokens: metrics?.usageReported ? metrics.inputTokens : null,
					outputTokens: metrics?.usageReported ? metrics.outputTokens : null,
					reviewedCount: result.coverage?.reviewedCount ?? null, libraryCount: catalog.length,
					mediaEmbeddingsAvailable: result.coverage?.mediaEmbeddingsAvailable ?? false,
					items: result.itemIds.flatMap(id => {
						const item = byId.get(id);
						return item ? [{ id, title: item.title, year: item.year, kind: item.kind,
							...(item.series !== undefined ? { series: item.series } : {}),
							...(item.season !== undefined ? { season: item.season } : {}),
							...(item.episode !== undefined ? { episode: item.episode } : {}),
							...(item.rating !== undefined ? { rating: item.rating } : {}) }] : [];
					}),
					});
					if (evaluate && !reliability && !pilot && !single && !result.coverage?.reviewStoppedEarly && round === 1) {
						runQueue.push({ value, ai, round: 2 });
					}
				}
				catch (cause) {
					const lastFailure = metrics?.requestDiagnostics.findLast(value => value.outcome === 'failed');
					rows.push({ name, ...(evaluate ? { round, estimatedCostUsd: (budget?.usedUsd ?? 0) - budgetBefore } : {}),
						...(lastFailure ? { failurePhase: lastFailure.phase, failureCategory: lastFailure.category } : {}),
						model: value.model, webSearch: value.webSearch, status: 'failed', count: 0,
						durationMs: Date.now() - started, requests: metrics?.requests ?? 0,
						reportedSearchCalls: metrics?.toolCalls ?? 0, inputTokens: metrics?.usageReported ? metrics.inputTokens : null,
						outputTokens: metrics?.usageReported ? metrics.outputTokens : null, reviewedCount: null,
						libraryCount: catalog.length, mediaEmbeddingsAvailable: Object.keys(vectors).length === catalog.length,
						items: [], error: cause instanceof AiSelectionError || cause instanceof EvaluationBudgetError
							? cause.message : 'Generation failed; inspect the provider and model configuration.',
					});
				}
				if (modelDirectory) {
					rows.at(-1)!.phases = await diagnosticPhases(modelDirectory);
					rows.at(-1)!.validation = rows.at(-1)!.status === 'failed' ? 'failed'
						: rows.at(-1)!.partial ? 'partial' : 'valid';
					await writeDiagnosticJson(join(modelDirectory, 'result.json'), rows.at(-1));
				}
			}
			console.table(rows.map(({ name, round, status, count, durationMs, requests, reportedSearchCalls, inputTokens, outputTokens, reviewedCount, mediaEmbeddingsAvailable, partial, estimatedCostUsd }) =>
				({ name, round, status, partial, count, seconds: Math.round(durationMs / 1000), requests, reportedSearchCalls, estimatedCostUsd,
					inputTokens, outputTokens, reviewedCount, mediaEmbeddingsAvailable })));
			const pairs = overlap(rows);
			if (pairs.length) {
				console.log('Pairwise selection overlap:');
				console.table(pairs);
			}
			for (const row of rows) {
				console.log(`\n${row.name}: ${row.status}${row.error ? ` — ${row.error}` : ''}`);
				if (row.status === 'completed') {
					console.log(row.items.map(item => {
						const series = item.series ? `${item.series} — ` : '';
						const episode = item.season != null && item.episode != null ? ` S${item.season}E${item.episode}` : '';
						const year = item.year === null ? '' : ` (${item.year})`;
						const rating = item.rating == null ? '' : ` · rating ${item.rating}`;
						return `${series}${item.title}${episode}${year}${rating}`;
					}).join('\n') || '(no matches)');
				}
			}
			if (outputPath) {
				const promptHash = createHash('sha256').update(prompt).digest('hex');
				await writeFile(outputPath, `${JSON.stringify({ libraryId: config.libraryId, promptHash,
					maxResults: config.maxResults, rows, overlap: pairs }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
				console.log(`\nWrote ${outputPath}`);
			}
			if (diagnosticDirectory) {
				await writeDiagnosticJson(join(diagnosticDirectory, 'summary.json'), {
					libraryId: config.libraryId, maxResults: config.maxResults, rows, overlap: pairs,
					...(budget ? { estimatedTotalCostUsd: budget.usedUsd, spendingLimitUsd: budget.limitUsd } : {}),
				});
			}
			if (rows.some(row => row.status === 'failed')) {
				process.exitCode = 1;
			}
		}
		finally {
			await extractor.dispose();
		}
	}
	finally {
		sqlite.close();
	}
}

/** Require an explicit paid-run flag; listing libraries is always read-only. */
async function main(): Promise<void> {
	const args = process.argv.slice(2);
	if (args.includes('--list-libraries')) {
		const customPath = args.includes('--database') ? args[args.indexOf('--database') + 1] : undefined;
		if (args.includes('--database') && (!customPath || customPath.startsWith('--'))) {
			throw new Error('Provide a path after --database.');
		}
		const path = databasePath(customPath, undefined);
		const sqlite = new Database(path, { readonly: true, fileMustExist: true });
		try {
			listLibraries(sqlite);
		}
		finally {
			sqlite.close();
		}
		return;
	}
	if (!args.includes('--run')) {
		console.log('Usage: npm run ai:compare -- --list-libraries [--database path]');
		console.log('       npm run ai:compare -- --run config.json [--output report.json] [--diagnose | --evaluate | --reliability] [--pilot] [--single] [--only model,...] [--json-schema-models model,...] [--prompt text] [--max-spend USD]');
		return;
	}
	const configPath = args[args.indexOf('--run') + 1];
	if (!configPath || configPath.startsWith('--')) {
		throw new Error('Provide a comparison JSON file after --run.');
	}
	const outputPath = args.includes('--output') ? args[args.indexOf('--output') + 1] : undefined;
	if (args.includes('--output') && (!outputPath || outputPath.startsWith('--'))) {
		throw new Error('Provide a path after --output.');
	}
	if (['--diagnose', '--evaluate', '--reliability'].filter(value => args.includes(value)).length > 1) {
		throw new Error('Choose one comparison mode.');
	}
	const evaluating = args.includes('--evaluate') || args.includes('--reliability');
	if (args.includes('--pilot') && !evaluating) {
		throw new Error('--pilot requires --evaluate or --reliability.');
	}
	const limitText = args.includes('--max-spend') ? args[args.indexOf('--max-spend') + 1] : undefined;
	const aggregateLimit = args.includes('--reliability') ? 30 : 10;
	const spendingLimitUsd = limitText === undefined ? aggregateLimit : Number(limitText);
	if (!Number.isFinite(spendingLimitUsd) || spendingLimitUsd <= 0 || spendingLimitUsd > aggregateLimit) {
		throw new Error(`--max-spend must be greater than zero and no more than ${aggregateLimit} USD.`);
	}
	const onlyText = args.includes('--only') ? args[args.indexOf('--only') + 1] : undefined;
	if (args.includes('--only') && (!onlyText || onlyText.startsWith('--'))) {
		throw new Error('Provide comma-separated model IDs after --only.');
	}
	const schemaText = args.includes('--json-schema-models') ? args[args.indexOf('--json-schema-models') + 1] : undefined;
	if (args.includes('--json-schema-models') && (!schemaText || schemaText.startsWith('--'))) {
		throw new Error('Provide comma-separated model IDs after --json-schema-models.');
	}
	const promptText = args.includes('--prompt') ? args[args.indexOf('--prompt') + 1] : undefined;
	if (args.includes('--prompt') && (!promptText || promptText.startsWith('--'))) {
		throw new Error('Provide prompt text after --prompt.');
	}
	await compare(
		resolve(configPath), 
		outputPath, 
		args.includes('--diagnose'), 
		evaluating,
		spendingLimitUsd, 
		onlyText ? new Set(onlyText.split(',')) : undefined,
		args.includes('--pilot'),
		args.includes('--reliability'),
		args.includes('--single'),
		promptText,
		schemaText ? new Set(schemaText.split(',')) : undefined,
	);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	await main();
}
