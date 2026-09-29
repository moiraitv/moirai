import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { displayedSettings, escapeHtml, plotExcerpt, posterData, renderComparisonHtml, type ReportRun } from '@scripts/ai-comparison-report.js';
import { reportRequestOptions, runReadyModels } from '@scripts/ai-production-comparison.js';

it('uses explicit comparison tuning without changing production configuration', () => {
	expect(reportRequestOptions('qwen/qwen3.5-397b-a17b', 'https://openrouter.ai/api/v1')).toMatchObject({
		provider: { ignore: ['Venice'], sort: 'throughput', allow_fallbacks: true },
	});
	expect(reportRequestOptions('deepseek/deepseek-v4-pro-0813', 'https://openrouter.ai/api/v1')).toMatchObject({
		provider: { sort: 'latency', allow_fallbacks: true },
	});
	expect(reportRequestOptions('gpt-6-sol', 'https://api.openai.com/v1').reasoningEffort).toBe('low');
	expect(reportRequestOptions('grok-4.7', 'https://api.x.ai/v1').reasoningEffort).toBe('low');
	expect(reportRequestOptions('claude-sonnet-5', 'https://api.anthropic.com/v1')).toMatchObject({
		protocol: 'anthropic-messages', disableThinking: true,
	});
});

it('continues after a failed model and stops dispatching when the aggregate budget is refused', async () => {
	const run = vi.fn(async (value: number) => value === 2 ? 'failed' as const
		: value === 3 ? 'budget limited' as const : 'completed' as const);
	expect(await runReadyModels([1, 2, 3, 4], run)).toEqual(['completed', 'failed', 'budget limited', 'budget limited']);
	expect(run.mock.calls.map(([value]) => value)).toEqual([1, 2, 3]);
});

it('escapes catalog text, bounds plots, and separates actual tiers in output order', () => {
	const plot = `${'🎃'.repeat(110)}<script>`;
	expect(Array.from(plotExcerpt(plot))).toHaveLength(100);
	expect(escapeHtml('A & <B> "C"')).toBe('A &amp; &lt;B&gt; &quot;C&quot;');
	const run: ReportRun = { name: 'Model <A>', model: 'test', settings: { reasoningEffort: 'low' },
		status: 'completed', durationMs: 1000, reviewedCount: 125, selectedCount: 2,
		inputTokens: 10, outputTokens: 5, estimatedCostUsd: 0.02, reviewStoppedEarly: true,
		finalReviewIncomplete: false, items: [
			{ id: '1', title: '<Core>', year: 2000, plot, poster: null, tier: 'core' },
			{ id: '2', title: 'Additional & more', year: null, plot: null, poster: null, tier: 'supporting' },
		] };
	const html = renderComparisonHtml('Prompt <unsafe>', 'Movies', [run], 15, 0.02);
	expect(html).toContain('Model &lt;A&gt;');
	expect(html).toContain('Prompt &lt;unsafe&gt;');
	expect(html).not.toContain('<Core>');
	expect(html).not.toContain('<script>');
	expect(html.indexOf('&lt;Core&gt;')).toBeLessThan(html.indexOf('Additional &amp; more'));
	expect(html).toContain('NO POSTER');
});

it('shows effective protocol defaults without leaking credentials from settings', () => {
	const shown = displayedSettings({ maxCompletionTokens: 4_096, reasoningEffort: 'low', apiKey: 'TOPSECRET' });
	expect(shown).toContain('chat-completions');
	expect(shown).toContain('json_object');
	expect(shown).toContain('maxCompletionTokens');
	expect(shown).not.toContain('TOPSECRET');
	expect(shown).not.toContain('apiKey');
	const native = displayedSettings({ protocol: 'anthropic-messages', disableThinking: true });
	expect(native).toContain('native JSON schema');
});

it('embeds resized local artwork and rejects traversal and outside symlinks', async () => {
	const root = await mkdtemp(join(tmpdir(), 'moirai-poster-test-'));
	const outside = await mkdtemp(join(tmpdir(), 'moirai-outside-test-'));
	try {
		await writeFile(join(root, 'poster.png'), await sharp({ create: { width: 300, height: 400,
			channels: 3, background: 'red' } }).png().toBuffer());
		await symlink(join(outside, 'secret.png'), join(root, 'outside.png'));
		expect(await posterData(root, 'poster.png')).toMatch(/^data:image\/webp;base64,/u);
		expect(await posterData(root, '../outside.png')).toBeNull();
		expect(await posterData(root, 'outside.png')).toBeNull();
	}
	finally {
		await rm(root, { recursive: true, force: true });
		await rm(outside, { recursive: true, force: true });
	}
});
