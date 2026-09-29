import type { FastifyBaseLogger } from 'fastify';
import type { AiContentSelectionResponse, AiProgress, AiProgressDetails } from '@moirai/shared';
import type { AppConfig } from '../config.js';
import { aiFailureCategory } from './errors.js';
import type { AiGenerationMetrics } from './pipeline.js';

/** Safe identity and settings for one generation; never include its prompt or credentials. */
interface AiRunIdentity {
	id?: string;
	libraryId: string;
	provider: string;
	model: string;
	webResearch: boolean;
	resultLimit: number | null;
}

/**
 * Write one run's lifecycle to the existing structured Log without provider text or catalog data.
 * Progress entries are deduplicated while terminal entries retain safe usage and timing metrics.
 */
export class AiRunLogger {
	private readonly started = Date.now();
	private readonly identity: AiRunIdentity;
	private phase = '';
	private metrics: AiGenerationMetrics | undefined;

	constructor(
		private readonly logger: Pick<FastifyBaseLogger, 'info' | 'warn'>,
		ai: NonNullable<AppConfig['ai']>,
		libraryId: string,
		resultLimit: number | null,
		id?: string,
	) {
		this.identity = { ...(id ? { id } : {}), libraryId, provider: ai.providerId ?? 'custom',
			model: ai.model, webResearch: ai.webSearch, resultLimit };
	}

	/** Record accepted work once the run, rather than a reconnect request, begins. */
	start(): void {
		this.logger.info({ aiGeneration: this.identity }, 'AI generation started');
	}

	/** Record stage or batch changes without logging every streamed provider event. */
	progress(status: AiProgress, details?: AiProgressDetails): void {
		const phase = `${status}:${details?.batch ?? ''}`;
		if (phase === this.phase) {
			return;
		}
		this.phase = phase;
		this.logger.info({ aiGeneration: { ...this.identity, phase: status,
			...(details?.batch ? { batch: details.batch, totalBatches: details.totalBatches } : {}),
			durationMs: Date.now() - this.started } }, 'AI generation progress');
	}

	/** Retain safe provider accounting for the terminal entry. */
	setMetrics(metrics: AiGenerationMetrics): void {
		this.metrics = metrics;
	}

	/** Record the number selected and any incomplete-work warnings. */
	complete(result: AiContentSelectionResponse): void {
		const context = { aiGeneration: { ...this.identity, durationMs: Date.now() - this.started,
			selectedCount: result.itemIds.length, reviewedCount: result.coverage?.reviewedCount ?? 0,
			...(result.coverage?.searchBudgetExhausted ? { searchBudgetExhausted: true } : {}),
			...(result.coverage?.reviewStoppedEarly ? { reviewStoppedEarly: true } : {}),
			...(result.coverage?.finalReviewIncomplete ? { finalReviewIncomplete: true } : {}),
			...(result.coverage?.localDiscoveryFallback ? { localDiscoveryFallback: true } : {}),
			...(this.metrics ? { metrics: this.metrics } : {}) } };
		if (this.metrics?.searchBudgetOverrun) {
			this.logger.warn(context, 'AI generation completed with search budget overrun');
		}
		else {
			this.logger.info(context, 'AI generation completed');
		}
	}

	/** Record a safe failure category and the last observed phase. */
	fail(cause: unknown): void {
		this.logger.warn({ aiGeneration: { ...this.identity, durationMs: Date.now() - this.started,
			phase: this.phase.split(':')[0] || 'preparing', failureCategory: aiFailureCategory(cause),
			...(this.metrics ? { metrics: this.metrics } : {}) } }, 'AI generation failed');
	}

	/** Record client or administrator cancellation without treating it as a provider failure. */
	cancel(): void {
		this.logger.info({ aiGeneration: { ...this.identity, durationMs: Date.now() - this.started,
			phase: this.phase.split(':')[0] || 'preparing' } }, 'AI generation cancelled');
	}
}
