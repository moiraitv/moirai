import { fork } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { AutoTokenizer } from '@huggingface/transformers';
import { budgetSemanticText, SEMANTIC_TOKEN_LIMIT } from '@server/semantic/token-budget.js';
import { semanticInput } from '@server/semantic/input.js';
import { expect, it } from 'vitest';
import { EMBEDDING_DIMENSIONS } from '@server/semantic/input.js';
import { normalizeVector, dot } from '@server/semantic/ranking.js';
import { fixture } from './fixtures.js';

it.skipIf(process.env.MOIRAI_EMBEDDING_INTEGRATION !== '1')('runs the actual local CPU model offline with repeatable normalized vectors and persists results', async () => {
	const f = await fixture();
	const worker = fork(new URL('../../../../../apps/server/dist/embedding-worker.js', import.meta.url), [path.resolve('apps/server/dist/embedding-model')], {
		stdio: ['ignore', 'ignore', 'ignore', 'ipc'], execArgv: ['--import', 'data:text/javascript,globalThis.fetch=()=>{throw new Error("Outbound fetch disabled")};'],
	});
	try {
		const infer = (text: string, media = false) => new Promise<number[]>((resolve, reject) => {
			worker.once('error', reject);
			worker.once('message', (result: { vector?: number[]; error?: string }) => {
				worker.off('error', reject);
				if (result.vector) {
					resolve(result.vector);
				}
				else {
					reject(new Error(result.error));
				}
			});
			worker.send(media ? { text, media } : text);
		});
		const input = f.semantic.reconcile()[0]!;
		const exclusion = await infer('superhero movies');
		const superhero = await infer('Title: Superman\nType: movie\nOverview: An alien with superhuman powers protects Earth as a costumed hero.');
		const scienceFiction = await infer('Title: Alien\nType: movie\nOverview: A spaceship crew encounters a deadly alien creature.');
		expect(dot(exclusion, superhero)).toBeGreaterThan(0.65);
		expect(dot(exclusion, scienceFiction)).toBeLessThan(0.65);
		const theme = await infer('Space exploration and first contact');
		const exploration = await infer('Title: First Contact\nType: movie\nOverview: Astronauts explore distant planets and meet an alien civilization.');
		const cooking = await infer('Title: Kitchen Stories\nType: movie\nOverview: A chef opens a restaurant and teaches traditional recipes.');
		expect(dot(theme, exploration)).toBeGreaterThan(dot(theme, cooking));
		const tokenizer = await AutoTokenizer.from_pretrained(path.resolve('apps/server/dist/embedding-model'), { local_files_only: true });
		const longInput = semanticInput(
			{ title: 'The Rescue', kind: 'episode', plot: 'Astronauts rescue a stranded explorer. '.repeat(400), metadata: { genres: ['Science Fiction'] } },
			[{ title: 'Deep Space', kind: 'show', plot: 'A station at the edge of the galaxy. '.repeat(400), metadata: {} }],
		);
		const budgeted = budgetSemanticText(longInput, tokenizer);
		expect(tokenizer.encode(budgeted, { add_special_tokens: false }).length).toBeLessThanOrEqual(SEMANTIC_TOKEN_LIMIT);
		expect(budgeted).toContain('astronauts rescue');
		expect(budgeted).toContain('deep space');
		expect(await infer(longInput, true)).toEqual(await infer(budgeted));
		const first = await infer(input.text, true);
		const second = await infer(input.text, true);
		expect(first).toHaveLength(EMBEDDING_DIMENSIONS);
		expect(first.every(Number.isFinite)).toBe(true);
		expect(first.reduce((sum, value) => sum + value * value, 0)).toBeCloseTo(1, 5);
		expect(second).toEqual(first);
		expect(f.semantic.store(input, first)).toBe(true);
		f.reopen();
		expect(f.semantic.catalog().vectors[input.id]).toEqual(normalizeVector(first).map(Math.fround));
		expect(f.semantic.reconcile().map((item) => item.id)).not.toContain(input.id);
	}
	finally {
		const exited = once(worker, 'exit');
		worker.kill('SIGKILL');
		await exited;
		await f.close();
	}
}, 90_000);
