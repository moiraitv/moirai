import { requestAiSelectionText } from '@server/ai/provider.js';
import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { AiGenerations, AI_GENERATION_RETENTION_MS, AI_GENERATION_CONCURRENCY, AI_GENERATION_CANCEL_GRACE_MS, AI_GENERATION_CAPACITY } from '@server/ai/generations.js';

afterEach(() => vi.useRealTimers());

const request = () => ({ id: randomUUID(), libraryId: randomUUID(), prompt: 'Movies' });
const result = { itemIds: [randomUUID()], unmatched: [], catalogTruncated: false };

it('retains completion after the initiating client leaves and starts duplicate requests only once', async () => {
	const jobs = new AiGenerations();
	const body = request();
	let finish!: (value: typeof result) => void;
	const run = vi.fn(() => new Promise<typeof result>(resolve => {
		finish = resolve;
	}));
	expect(jobs.start('owner', body, run).state).toBe('running');
	jobs.start('owner', body, run);
	await Promise.resolve();
	expect(run).toHaveBeenCalledTimes(1);
	expect(() => jobs.get('someone-else', body.id)).toThrow('expired');
	expect(() => jobs.start('someone-else', body, run)).toThrow('already in use');
	expect(() => jobs.start('owner', { ...body, prompt: 'Changed' }, run)).toThrow('already in use');
	expect(() => jobs.start('owner', { ...body, maxResults: 50 }, run)).toThrow('already in use');
	finish(result);
	await vi.waitFor(() => expect(jobs.get('owner', body.id)).toMatchObject({ state: 'completed', result }));
});

it('cancels upstream work and rejects its late completion', async () => {
	const jobs = new AiGenerations();
	const body = request();
	let finish!: (value: typeof result) => void;
	let signal: AbortSignal | undefined;
	jobs.start('owner', body, activity => {
		signal = activity.signal;
		return new Promise(resolve => {
			finish = resolve;
		});
	});
	await Promise.resolve();
	jobs.cancel('owner', body.id);
	expect(signal?.aborted).toBe(true);
	finish(result);
	await new Promise(resolve => setTimeout(resolve, 0));
	expect(() => jobs.get('owner', body.id)).toThrow('expired');
	expect(() => jobs.start('owner', body, async () => result)).toThrow('cancelled');
});

it('releases canceled jobs from capacity without starting their queued work', async () => {
	const jobs = new AiGenerations();
	const run = vi.fn(async () => result);
	for (let i = 0; i < AI_GENERATION_CAPACITY; i += 1) {
		const body = request();
		jobs.start('owner', body, run);
		jobs.cancel('owner', body.id);
		expect(() => jobs.start('owner', body, run)).toThrow('cancelled');
	}
	await Promise.resolve();
	expect(run).not.toHaveBeenCalled();
	expect(jobs.start('owner', request(), run).state).toBe('running');
});

it('does not start paid work when cancellation arrives before the job exists', async () => {
	const jobs = new AiGenerations();
	const body = request();
	const run = vi.fn(async () => result);
	expect(() => jobs.cancel('owner', body.id)).toThrow('expired');
	expect(() => jobs.start('owner', body, run)).toThrow('cancelled');
	expect(() => jobs.start('someone-else', body, run)).toThrow('already in use');
	await Promise.resolve();
	expect(run).not.toHaveBeenCalled();
});

it('allows the same id to start after the cancellation grace expires', () => {
	vi.useFakeTimers();
	const jobs = new AiGenerations();
	const body = request();
	expect(() => jobs.cancel('owner', body.id)).toThrow('expired');
	vi.advanceTimersByTime(AI_GENERATION_CANCEL_GRACE_MS + 1);
	expect(jobs.start('owner', body, async () => result).state).toBe('running');
});

it('counts request-scoped selection toward the same concurrency limit', () => {
	const jobs = new AiGenerations();
	const release = [jobs.acquire('owner'), jobs.acquire('owner')];
	expect(() => jobs.acquire('owner')).toThrow('capacity');
	expect(() => jobs.start('owner', request(), async () => result)).toThrow('capacity');
	const other = jobs.acquire('other');
	release[0]!();
	expect(jobs.start('owner', request(), async () => result).state).toBe('running');
	other();
});

it('bounds concurrent paid work and aborts it on shutdown', async () => {
	const jobs = new AiGenerations();
	const signals: AbortSignal[] = [];
	for (let i = 0; i < AI_GENERATION_CONCURRENCY; i += 1) {
		jobs.start('owner', request(), activity => {
			signals.push(activity.signal!);
			return new Promise(() => {});
		});
	}
	expect(() => jobs.start('owner', request(), async () => result)).toThrow('capacity');
	await Promise.resolve();
	jobs.close();
	expect(signals.every(signal => signal.aborted)).toBe(true);
});

it('expires terminal results without retrying failed work or exposing arbitrary errors', async () => {
	vi.useFakeTimers();
	const jobs = new AiGenerations();
	const body = request();
	jobs.start('owner', body, async () => {
		throw new Error('private provider details');
	});
	await vi.runAllTimersAsync();
	expect(jobs.get('owner', body.id).message).not.toContain('private');
	await vi.advanceTimersByTimeAsync(AI_GENERATION_RETENTION_MS + 1);
	expect(() => jobs.get('owner', body.id)).toThrow('expired');
});


it.each([400, 401])('preserves sanitized provider HTTP %i guidance in retained failures', async status => {
	const jobs = new AiGenerations();
	const body = request();
	jobs.start('owner', body, async activity => {
		await requestAiSelectionText(
			{ apiKey: 'secret-key', baseUrl: 'https://example.test', model: 'test', webSearch: true }, 
			[],
			async () => new Response('private upstream diagnostic', { status }), 
			activity,
		);
		return result;
	});
	await vi.waitFor(() => expect(jobs.get('owner', body.id).state).toBe('failed'));
	const message = jobs.get('owner', body.id).message!;
	expect(message).toContain(`HTTP ${status}`);
	expect(message).toContain(status === 400 ? 'disable web research' : 'API key');
	expect(message).not.toContain('private upstream');
	expect(message).not.toContain('secret-key');
});
