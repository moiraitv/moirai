import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { AiRequestActivity } from '../apps/server/src/ai/provider.js';

/** Conservative standard USD rates per million tokens for the five evaluation models. */
const RATES: Record<string, { input: number; output: number }> = {
	'qwen/qwen3.5-397b-a17b': { input: 0.75, output: 4.5 },
	'deepseek/deepseek-v4-pro-0813': { input: 1.32, output: 3.96 },
	'gpt-6-sol': { input: 2, output: 10 },
	'grok-4.7': { input: 2, output: 6 },
	'claude-sonnet-5': { input: 3, output: 15 },
};

/** Proven tuning candidates for the diagnostic comparison, never inferred for production. */
export function evaluationOptions(model: string, baseUrl: string): Pick<AiRequestActivity, 'maxCompletionTokens' | 'reasoningEffort' | 'disableThinking' | 'provider' | 'protocol'> {
	return {
		maxCompletionTokens: 4_096,
		...(model === 'claude-sonnet-5' ? { disableThinking: true,
			...(new URL(baseUrl).hostname === 'api.anthropic.com' ? { protocol: 'anthropic-messages' as const } : {}) }
			: { reasoningEffort: ['qwen/qwen3.5-397b-a17b', 'deepseek/deepseek-v4-pro-0813'].includes(model)
				? 'none' as const : 'low' as const }),
		...(model === 'qwen/qwen3.5-397b-a17b' && new URL(baseUrl).hostname === 'openrouter.ai'
			? { provider: { ignore: ['Venice'], sort: 'throughput' as const, allow_fallbacks: true, require_parameters: true } } : {}),
		...(model === 'deepseek/deepseek-v4-pro-0813' && new URL(baseUrl).hostname === 'openrouter.ai'
			? { provider: { sort: 'latency' as const, allow_fallbacks: true, require_parameters: true } } : {}),
	};
}

/** Slow reasoning models use local prompt concepts before a bounded library review. */
export function evaluationUsesLocalDiscovery(model: string): boolean {
	return model === 'grok-4.7';
}

/** Bound paid evaluation requests before dispatch and retain uncertain costs after transport failure. */
export class EvaluationBudgetError extends Error {}

/** Conservative reservations persist before each paid request, including across invocations. */
export class EvaluationBudget {
	private committed = 0;
	private reserved = 0;
	private runCommitted = 0;

	constructor(readonly limitUsd: number, private readonly ledgerPath?: string, private readonly runLimitUsd = limitUsd) {
		if (ledgerPath) {
			try {
				const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8')) as { limitUsd: number; reservedUsd: number };
				if (ledger.limitUsd !== limitUsd || !Number.isFinite(ledger.reservedUsd) || ledger.reservedUsd < 0 || ledger.reservedUsd > limitUsd) {
					throw new Error('Evaluation budget ledger is invalid or has a different limit.');
				}
				this.committed = ledger.reservedUsd;
			}
			catch (cause) {
				if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') {
					throw cause;
				}
				this.persist();
			}
		}
	}

	/** Conservative accumulated charge, including unconfirmed requests. */
	get usedUsd(): number {
		return this.committed + this.reserved;
	}

	/** Save every reservation before dispatch, retaining ambiguous transport charges. */
	private persist(): void {
		if (!this.ledgerPath) {
			return;
		}
		const temporary = `${this.ledgerPath}.tmp`;
		writeFileSync(temporary, `${JSON.stringify({ limitUsd: this.limitUsd, reservedUsd: this.usedUsd })}\n`, { mode: 0o600 });
		renameSync(temporary, this.ledgerPath);
	}

	/** Refuse work whose possible token bill exceeds the remaining allowance. */
	fetch(fetchImpl: typeof fetch = fetch): typeof fetch {
		return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
			if (typeof init?.body !== 'string') {
				throw new Error('Evaluation budget requires a JSON request body.');
			}
			const body = JSON.parse(init.body) as { model?: string; max_completion_tokens?: number; max_output_tokens?: number; max_tokens?: number };
			const rates = body.model ? RATES[body.model] : undefined;
			const outputLimit = body.max_completion_tokens ?? body.max_output_tokens ?? body.max_tokens;
			if (!rates || !Number.isInteger(outputLimit) || outputLimit! < 1) {
				throw new Error('Evaluation budget requires a priced model and bounded output.');
			}
			// UTF-8 bytes upper-bound ordinary input tokens; double published rates for margin.
			const reserve = 2 * (Buffer.byteLength(init.body, 'utf8') * rates.input + outputLimit! * rates.output) / 1_000_000;
			if (this.usedUsd + reserve > this.limitUsd || this.runCommitted + reserve > this.runLimitUsd) {
				throw new EvaluationBudgetError('Evaluation spending limit reached before the next request.');
			}
			this.reserved += reserve;
			this.runCommitted += reserve;
			try {
				this.persist();
			}
			catch (cause) {
				this.reserved -= reserve;
				this.runCommitted -= reserve;
				throw cause;
			}
			try {
				return await fetchImpl(input, init);
			}
			finally {
				this.reserved -= reserve;
				this.committed += reserve;
			}
		}) as typeof fetch;
	}
}
