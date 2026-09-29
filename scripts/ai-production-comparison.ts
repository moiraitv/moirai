import { chmod, mkdtemp, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { env, pipeline } from '@huggingface/transformers';
import { generateAiSelection, type AiGenerationMetrics } from '../apps/server/src/ai/pipeline.js';
import { readAiCatalog } from '../apps/server/src/repository/ai-catalog.js';
import { SemanticRepository } from '../apps/server/src/repository/semantic.js';
import { loadConfig } from '../apps/server/src/config.js';
import { AiSelectionError } from '../apps/server/src/ai/errors.js';
import type { AiRequestActivity } from '../apps/server/src/ai/provider.js';
import * as schema from '../apps/server/src/db/schema.js';
import * as semanticSchema from '../apps/server/src/db/semantic-schema.js';
import { comparisonSchema, configuredModel, preflightProviders, type ModelPreflight } from './compare-ai-models.js';
import { EvaluationBudget, EvaluationBudgetError, evaluationOptions } from './ai-evaluation.js';
import { renderComparisonHtml, reportItems, type ReportRun } from './ai-comparison-report.js';

/** Fresh, aggregate ceiling for this one five-model comparison. */
const SPENDING_CAP_USD = 15;
/** Keep this comparison at the application's current five-minute deadline. */
const MAX_RESULTS = 200;

/** Run explicit evaluation profiles without adding model-name routing to production. */
export function reportRequestOptions(model: string, baseUrl: string): Pick<AiRequestActivity,
	'maxCompletionTokens' | 'reasoningEffort' | 'disableThinking' | 'provider' | 'protocol' | 'chatJsonMode'> {
	const tuned = evaluationOptions(model, baseUrl);
	return model === 'claude-sonnet-5' ? { maxCompletionTokens: 4_096,
		protocol: 'anthropic-messages', disableThinking: true } : tuned;
}

/** Continue through independent runs, except after the shared spending ceiling is reached. */
export async function runReadyModels<T>(models: T[], run: (model: T) => Promise<'completed' | 'failed' | 'budget limited'>): Promise<Array<'completed' | 'failed' | 'budget limited'>> {
	const statuses: Array<'completed' | 'failed' | 'budget limited'> = [];
	let limited = false;
	for (const model of models) {
		if (limited) {
			statuses.push('budget limited');
			continue;
		}
		const status = await run(model);
		statuses.push(status);
		limited = status === 'budget limited';
	}
	return statuses;
}

/** Atomically refresh a private artifact so an interrupted run keeps completed models. */
async function replacePrivate(path: string, text: string): Promise<void> {
	const temporary = `${path}.tmp`;
	await writeFile(temporary, text, { mode: 0o600 });
	await rename(temporary, path);
}

/** Produce one new report using read-only development data and paid provider requests. */
export async function createProductionComparison(configPath: string): Promise<string> {
	const config = comparisonSchema.parse(JSON.parse(await readFile(configPath, 'utf8')));
	if (config.models.length !== 5 || config.maxResults !== MAX_RESULTS || config.models.some(value => value.webSearch)) {
		throw new Error('This report requires the five configured non-search models and a 200-result ceiling.');
	}
	const names = config.models.map(value => value.name ?? value.model);
	if (new Set(names).size !== 5) {
		throw new Error('Comparison model names must be unique.');
	}
	const credentialFailures: Array<{ name: string; model: string; settings: ReturnType<typeof reportRequestOptions> }> = [];
	const resolved = config.models.flatMap(value => {
		const name = value.name ?? value.model;
		const settings = { ...reportRequestOptions(value.model, value.baseUrl),
			...(value.chatJsonMode && value.model !== 'claude-sonnet-5' ? { chatJsonMode: value.chatJsonMode } : {}) };
		try {
			return [{ value, ai: configuredModel(value), name, settings }];
		}
		catch {
			credentialFailures.push({ name, model: value.model, settings });
			return [];
		}
	});
	const databasePath = config.databasePath
		? isAbsolute(config.databasePath) ? config.databasePath : resolve(dirname(configPath), config.databasePath)
		: loadConfig({ ai: null }).databasePath;
	const sqlite = new Database(databasePath, { readonly: true, fileMustExist: true });
	try {
		const library = sqlite.prepare('SELECT name, type_key AS typeKey, source_config AS sourceConfig FROM libraries WHERE id=?')
			.get(config.libraryId) as { name: string; typeKey: string; sourceConfig: string } | undefined;
		if (!library) {
			throw new Error('Configured library was not found in the development database.');
		}
		const scanRoot = (JSON.parse(library.sourceConfig) as { scanRoot?: unknown }).scanRoot;
		if (typeof scanRoot !== 'string' || !isAbsolute(scanRoot)) {
			throw new Error('The development library has no local poster root.');
		}
		const db = drizzle(sqlite, { schema: { ...schema, ...semanticSchema } });
		const catalog = await readAiCatalog(db, config.libraryId);
		const vectors = new SemanticRepository(db).retrievalVectors(config.libraryId);
		if (!catalog.length) {
			throw new Error('The development library has no indexed movies.');
		}
		const directory = await mkdtemp(join(dirname(configPath), `production-comparison-${new Date().toISOString().replace(/[:.]/gu, '-')}-`));
		await chmod(directory, 0o700);
		const budget = new EvaluationBudget(SPENDING_CAP_USD, join(directory, 'spending-ledger.json'));
		const chargedFetch = budget.fetch();
		const rows: ReportRun[] = credentialFailures.map(entry => ({ ...entry,
			status: 'preflight failed', durationMs: 0, reviewedCount: null, selectedCount: 0,
			inputTokens: null, outputTokens: null, estimatedCostUsd: 0, reviewStoppedEarly: false,
			finalReviewIncomplete: false, items: [], error: 'Credential is unavailable.' }));
		const save = async (): Promise<void> => {
			await replacePrivate(join(directory, 'summary.json'), `${JSON.stringify({ libraryId: config.libraryId,
				libraryCount: catalog.length, maxResults: MAX_RESULTS, spendingCapUsd: SPENDING_CAP_USD,
				conservativeReservedUsd: budget.usedUsd, runs: rows.map(({ items, ...row }) => ({ ...row,
					coreCount: items.filter(item => item.tier === 'core').length,
					additionalCount: items.filter(item => item.tier === 'supporting').length })) }, null, 2)}\n`);
			await replacePrivate(join(directory, 'report.html'), renderComparisonHtml(
				config.prompt, 
				library.name,
				rows, 
				SPENDING_CAP_USD, 
				budget.usedUsd,
			));
		};
		await save();
		console.log(`Private report: ${join(directory, 'report.html')}`);
		console.log(`Development library: ${library.name} (${catalog.length} movies)`);

		// Check every endpoint before starting full generation; retain failures as report columns.
		const checks: Array<ModelPreflight | { name: string; status: 'budget limited'; issue: string }> = [];
		let preflightBudgetLimited = false;
		for (const entry of resolved) {
			if (preflightBudgetLimited) {
				checks.push({ name: entry.name, status: 'budget limited' as const, issue: 'Spending cap reached during preflight.' });
				continue;
			}
			const check = (await preflightProviders([{ name: entry.name, ai: entry.ai,
				...(entry.settings.chatJsonMode ? { chatJsonMode: entry.settings.chatJsonMode } : {}),
				requestOptions: entry.settings }], chargedFetch))[0]!;
			preflightBudgetLimited = check.issue === 'Evaluation spending limit reached before the next request.';
			checks.push(check);
			console.log(`Preflight ${entry.name}: ${check.status}${check.issue ? ` (${check.issue})` : ''}`);
		}
		for (const [index, check] of checks.entries()) {
			if (check.status === 'ready') {
				continue;
			}
			const entry = resolved[index]!;
			rows.push({ name: entry.name, model: entry.value.model, settings: entry.settings,
				status: check.status === 'budget limited' ? 'budget limited' : 'preflight failed',
				durationMs: 0, reviewedCount: null, selectedCount: 0, inputTokens: null, outputTokens: null,
				estimatedCostUsd: 0, reviewStoppedEarly: false, finalReviewIncomplete: false, items: [],
				error: check.issue ?? 'Preflight failed.' });
		}
		await save();
		if (preflightBudgetLimited) {
			for (const entry of resolved) {
				if (!rows.some(row => row.name === entry.name)) {
					rows.push({ name: entry.name, model: entry.value.model, settings: entry.settings,
						status: 'budget limited', durationMs: 0, reviewedCount: null, selectedCount: 0,
						inputTokens: null, outputTokens: null, estimatedCostUsd: 0, reviewStoppedEarly: false,
						finalReviewIncomplete: false, items: [], error: 'Spending cap reached during preflight.' });
				}
			}
			rows.sort((a, b) => names.indexOf(a.name) - names.indexOf(b.name));
			await save();
			return directory;
		}

		env.allowRemoteModels = false;
		env.useFSCache = false;
		const extractor = await pipeline('feature-extraction', resolve('apps/server/dist/embedding-model'), {
			device: 'cpu', dtype: 'fp32', local_files_only: true,
			session_options: { intraOpNumThreads: 1, interOpNumThreads: 1, executionMode: 'sequential' },
		});
		try {
			const queries = new Map<string, number[]>();
			const ready = resolved.filter(entry => checks.find(check => check.name === entry.name)?.status === 'ready');
			await runReadyModels(ready, async entry => {
				const started = Date.now();
				const costBefore = budget.usedUsd;
				let metrics: AiGenerationMetrics | undefined;
				let tiers: { coreItemIds: string[]; supportingItemIds: string[] } | undefined;
				let budgetRefused = false;
				const runFetch: typeof fetch = (async (input, init) => {
					try {
						return await chargedFetch(input, init);
					}
					catch (cause) {
						if (cause instanceof EvaluationBudgetError) {
							budgetRefused = true;
						}
						throw cause;
					}
				}) as typeof fetch;
				console.log(`Running ${entry.name}...`);
				let row: ReportRun;
				try {
					const result = await generateAiSelection(entry.ai, config.prompt, library.typeKey, {
						fastLocalReview: true, requestOptions: entry.settings, fetchImpl: runFetch,
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
						onSelectionTiers: value => {
							tiers = value;
						},
					}, {}, MAX_RESULTS);
					if (!tiers || result.itemIds.join() !== [...tiers.coreItemIds, ...tiers.supportingItemIds].join()) {
						throw new Error('Validated tier capture did not match the selected order.');
					}
					const durationMs = Date.now() - started;
					const items = await reportItems(sqlite, config.libraryId, scanRoot, tiers.coreItemIds, tiers.supportingItemIds);
					row = { name: entry.name, model: entry.value.model, settings: entry.settings, status: 'completed',
						durationMs, reviewedCount: result.coverage?.reviewedCount ?? null,
						selectedCount: result.itemIds.length, inputTokens: metrics?.usageReported ? metrics.inputTokens : null,
						outputTokens: metrics?.usageReported ? metrics.outputTokens : null,
						estimatedCostUsd: budget.usedUsd - costBefore,
						reviewStoppedEarly: result.coverage?.reviewStoppedEarly === true,
						finalReviewIncomplete: result.coverage?.finalReviewIncomplete === true,
						localDiscoveryFallback: result.coverage?.localDiscoveryFallback === true, items };
				}
				catch (cause) {
					const lastFailure = metrics?.requestDiagnostics.findLast(value => value.outcome === 'failed');
					row = { name: entry.name, model: entry.value.model, settings: entry.settings,
						status: budgetRefused ? 'budget limited' : 'failed', durationMs: Date.now() - started,
						reviewedCount: null, selectedCount: 0,
						inputTokens: metrics?.usageReported ? metrics.inputTokens : null,
						outputTokens: metrics?.usageReported ? metrics.outputTokens : null,
						estimatedCostUsd: budget.usedUsd - costBefore,
						reviewStoppedEarly: false, finalReviewIncomplete: false, items: [],
						...(lastFailure ? { failurePhase: lastFailure.phase, failureCategory: lastFailure.category } : {}),
						error: budgetRefused ? 'Spending cap reached before the next request.'
							: cause instanceof AiSelectionError ? cause.message : 'Generation failed; inspect provider configuration.' };
				}
				rows.push(row);
				await save();
				console.log(`${entry.name}: ${row.status}, ${row.selectedCount} selected, ${Math.round(row.durationMs / 1000)}s, $${row.estimatedCostUsd.toFixed(3)} reserved`);
				return budgetRefused ? 'budget limited' : row.status === 'completed' ? 'completed' : 'failed';
			});
			for (const entry of ready) {
				if (!rows.some(row => row.name === entry.name)) {
					rows.push({ name: entry.name, model: entry.value.model, settings: entry.settings,
						status: 'budget limited', durationMs: 0, reviewedCount: null, selectedCount: 0,
						inputTokens: null, outputTokens: null, estimatedCostUsd: 0, reviewStoppedEarly: false,
						finalReviewIncomplete: false, items: [], error: 'Spending cap reached before this model.' });
				}
			}
			rows.sort((a, b) => names.indexOf(a.name) - names.indexOf(b.name));
			await save();
		}
		finally {
			await extractor.dispose();
		}
		return directory;
	}
	finally {
		sqlite.close();
	}
}

/** Launch the paid comparison only with its explicit run flag. */
async function main(): Promise<void> {
	const args = process.argv.slice(2);
	if (args[0] !== '--run' || !args[1]) {
		throw new Error('Usage: npm run ai:compare:html -- --run ~/Projects/moirai-tests/compare-ai-models.json');
	}
	console.log(`Report directory: ${await createProductionComparison(resolve(args[1]))}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	await main();
}
