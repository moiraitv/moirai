import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { EvaluationBudget, evaluationOptions } from '@scripts/ai-evaluation.js';

it('sets bounded low-effort requests and excludes the failing Qwen host', () => {
	expect(evaluationOptions('qwen/qwen3.5-397b-a17b', 'https://openrouter.ai/api/v1')).toMatchObject({
		maxCompletionTokens: 4_096, reasoningEffort: 'none',
		provider: { ignore: ['Venice'], sort: 'throughput', allow_fallbacks: true, require_parameters: true },
	});
	expect(evaluationOptions('deepseek/deepseek-v4-pro-0813', 'https://openrouter.ai/api/v1')).toMatchObject({
		reasoningEffort: 'none', provider: { sort: 'latency', allow_fallbacks: true, require_parameters: true },
	});
	expect(evaluationOptions('grok-4.7', 'https://api.x.ai/v1')).toMatchObject({
		maxCompletionTokens: 4_096, reasoningEffort: 'low',
	});
	expect(evaluationOptions('claude-sonnet-5', 'https://api.anthropic.com/v1')).toMatchObject({
		disableThinking: true, protocol: 'anthropic-messages',
	});
});

it('reserves concurrent requests before dispatch and refuses work beyond the allowance', async () => {
	const release: Array<(value: Response) => void> = [];
	const upstream = vi.fn<typeof fetch>(async () => new Promise(resolve => release.push(resolve)));
	const budget = new EvaluationBudget(0.13);
	const request = { method: 'POST', body: JSON.stringify({ model: 'gpt-6-sol', max_completion_tokens: 4_096,
		messages: [{ role: 'user', content: 'Halloween' }] }) };
	const fetchImpl = budget.fetch(upstream);
	const first = fetchImpl('https://api.openai.com/v1/chat/completions', request);
	await expect(fetchImpl('https://api.openai.com/v1/chat/completions', request))
		.rejects.toThrow('spending limit');
	expect(upstream).toHaveBeenCalledTimes(1);
	release[0]!(Response.json({ usage: { prompt_tokens: 100, completion_tokens: 50 } }));
	await first;
	expect(budget.usedUsd).toBeGreaterThan(0);
	expect(budget.usedUsd).toBeLessThan(0.13);
});

it('keeps the full reservation when a paid request loses its connection', async () => {
	const budget = new EvaluationBudget(0.1);
	const fetchImpl = budget.fetch(async () => {
		throw new TypeError('connection lost');
	});
	await expect(fetchImpl('https://api.x.ai/v1/chat/completions', { method: 'POST',
		body: JSON.stringify({ model: 'grok-4.7', max_completion_tokens: 4_096, messages: [] }) }))
		.rejects.toThrow('connection lost');
	expect(budget.usedUsd).toBeGreaterThan(0);
});

it('keeps one private aggregate cap across invocations and prices native output limits', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'moirai-evaluation-budget-'));
	const ledger = join(directory, 'budget.json');
	const request = { method: 'POST', body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 4_096, messages: [] }) };
	const upstream = vi.fn<typeof fetch>(async () => Response.json({ stop_reason: 'end_turn', content: [] }));
	try {
		await new EvaluationBudget(0.2, ledger).fetch(upstream)('https://api.anthropic.com/v1/messages', request);
		await expect(new EvaluationBudget(0.2, ledger).fetch(upstream)('https://api.anthropic.com/v1/messages', request))
			.rejects.toThrow('spending limit');
		expect(upstream).toHaveBeenCalledTimes(1);
		const saved = JSON.parse(await readFile(ledger, 'utf8'));
		expect(saved.reservedUsd).toBeGreaterThan(0);
		expect(() => new EvaluationBudget(0.1, ledger)).toThrow('different limit');
	}
	finally {
		await rm(directory, { recursive: true, force: true });
	}
});
