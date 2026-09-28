import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { env, pipeline } from '@huggingface/transformers';
import { loadConfig } from '../apps/server/src/config.js';
import { generateAiSelection } from '../apps/server/src/ai/pipeline.js';
import { requestAiSelectionText, type AiRequestUsage } from '../apps/server/src/ai/provider.js';
import { semanticInput } from '../apps/server/src/semantic/input.js';
import { budgetSemanticText } from '../apps/server/src/semantic/token-budget.js';

/** Evaluation inputs require editorial labels and may include sparse local plots. */
const suiteSchema = z.object({
	baselinePrompt: z.string(),
	catalog: z.array(z.object({ id: z.string(), title: z.string(), year: z.number().nullable(), kind: z.string(), genres: z.array(z.string()),
		plot: z.string().default(''), series: z.string().nullable().optional(), seriesYear: z.number().nullable().optional(),
		season: z.number().nullable().optional(), episode: z.number().nullable().optional() })),
	cases: z.array(z.object({ name: z.string(), prompt: z.string(), expectedIds: z.array(z.string()) })),
});

/** Report inclusion accuracy and coverage, keeping empty expected/selected sets meaningful. */
function scores(actual: string[], expected: string[]): { precision: number; recall: number } {
	const ids = new Set(actual);
	const expectedSet = new Set(expected);
	const correct = [...ids].filter(id => expectedSet.has(id)).length;
	return { precision: ids.size ? correct / ids.size : expectedSet.size ? 0 : 1,
		recall: expectedSet.size ? correct / expectedSet.size : 1 };
}

/** Run paid baseline/new comparisons only after an explicit --run; no production database writes. */
async function main(): Promise<void> {
	if (!process.argv.includes('--run')) {
		console.log('Opt-in paid evaluation: node --env-file=.env --import tsx scripts/evaluate-ai.ts --run [suite.json]');
		return;
	}
	const ai = loadConfig().ai;
	if (!ai) {
		throw new Error('Configure all four AI settings before evaluation.');
	}
	const filename = process.argv.slice(2).find(value => value !== '--run') ?? 'tests/fixtures/ai/selection-evaluation.json';
	const suite = suiteSchema.parse(JSON.parse(await readFile(filename, 'utf8')));
	env.allowRemoteModels = false;
	env.useFSCache = false;
	const extractor = await pipeline('feature-extraction', resolve('apps/server/dist/embedding-model'), {
		device: 'cpu', dtype: 'fp32', local_files_only: true,
		session_options: { intraOpNumThreads: 1, interOpNumThreads: 1, executionMode: 'sequential' },
	});
	try {
		const vectors: Record<string, number[]> = {};
		for (const item of suite.catalog) {
			const text = semanticInput({ ...item, metadata: { genres: item.genres } }, item.series ? [
				{ title: item.series, kind: 'show', plot: null, metadata: {} },
			] : []);
			vectors[item.id] = Array.from((await extractor(budgetSemanticText(text, extractor.tokenizer), { pooling: 'cls', normalize: true })).data);
		}
		const queryCache = new Map<string, number[]>();
		for (const test of suite.cases) {
			let baselineUsage: AiRequestUsage | undefined;
			const started = Date.now();
			let bytes = 0;
			const baselineCatalog = [...suite.catalog].sort((a, b) => a.title.localeCompare(b.title)).slice(0, 8_000).filter(item => {
				bytes += Buffer.byteLength(JSON.stringify([item.title, item.year, item.kind, item.genres])) + 1;
				return bytes <= 128 * 1024;
			});
			const baselineText = await requestAiSelectionText(ai, [
				{ role: 'system', content: suite.baselinePrompt },
				{ role: 'user', content: `${test.prompt}\nLibrary rows [title,year,type,genres]:\n${baselineCatalog.map(item => JSON.stringify([item.title, item.year, item.kind, item.genres])).join('\n')}` },
			], fetch, { maxToolCalls: 5, signal: AbortSignal.timeout(120_000), onUsage: value => {
				baselineUsage = value; 
			} });
			const baseline = z.object({ matches: z.array(z.object({ title: z.string(), year: z.number().nullable() })) }).parse(JSON.parse(baselineText));
			const baselineIds = baselineCatalog.filter(item => baseline.matches.some(match => match.title.trim().toLowerCase() === item.title.trim().toLowerCase() && match.year === item.year)).map(item => item.id);
			console.log(JSON.stringify({ case: test.name, variant: 'baseline', ...scores(baselineIds, test.expectedIds),
				candidateRecall: scores(baselineCatalog.map(item => item.id), test.expectedIds).recall,
				durationMs: Date.now() - started, requests: 1, ...baselineUsage }));
			let reviewed: string[] = [];
			const result = await generateAiSelection(ai, test.prompt, suite.catalog.some(item => item.kind === 'episode') ? 'shows' : 'movies', {
				loadCatalog: async () => suite.catalog,
				loadVectors: async concepts => {
					for (const concept of concepts) {
						if (!queryCache.has(concept)) {
							queryCache.set(concept, Array.from((await extractor(concept, { pooling: 'cls', normalize: true })).data));
						}
					}
					return { vectors, queries: concepts.map(concept => queryCache.get(concept)!), available: true };
				},
				onCandidates: ids => {
					reviewed = ids; 
				},
				onMetrics: metrics => console.log(JSON.stringify({ case: test.name, variant: 'new', ...metrics })),
			});
			console.log(JSON.stringify({ case: test.name, variant: 'new', ...scores(result.itemIds, test.expectedIds),
				candidateRecall: scores(reviewed, test.expectedIds).recall, coverage: result.coverage }));
		}
	}
	finally {
		await extractor.dispose();
	}
}

await main();
