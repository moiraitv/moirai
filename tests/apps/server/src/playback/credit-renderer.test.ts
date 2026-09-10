import { expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ workers: [] as Array<{ emit: (event: string, value: unknown) => void }>, active: 0, peak: 0 }));
vi.mock('node:worker_threads', async () => {
	const { EventEmitter } = await import('node:events');
	return { Worker: class extends EventEmitter {
		constructor() {
			super();
			state.workers.push(this);
			state.active += 1;
			state.peak = Math.max(state.peak, state.active);
		}
		async terminate() {
			state.active -= 1;
			return 0;
		}
	} };
});
import { CreditRendererBusyError, MAX_ACTIVE_CREDIT_RENDERS, MAX_PENDING_CREDIT_RENDERS, renderCreditTemplate } from '@server/playback/credit-renderer.js';

it('bounds active workers and queued work, and drains queued renders without dropping results', async () => {
	const count = MAX_ACTIVE_CREDIT_RENDERS + MAX_PENDING_CREDIT_RENDERS;
	const start = state.workers.length;
	const renders = Array.from({ length: count }, () => renderCreditTemplate('template', {}));
	await expect(renderCreditTemplate('overflow', {})).rejects.toBeInstanceOf(CreditRendererBusyError);
	await vi.waitFor(() => expect(state.workers.length - start).toBe(MAX_ACTIVE_CREDIT_RENDERS));
	for (let index = 0; index < count; index += 1) {
		await vi.waitFor(() => expect(state.workers.length - start).toBeGreaterThan(index));
		state.workers[start + index]!.emit('message', { ass: `render ${index}` });
	}
	expect(await Promise.all(renders)).toEqual(Array.from({ length: count }, (_, index) => `render ${index}`));
	expect(state.peak).toBe(MAX_ACTIVE_CREDIT_RENDERS);
	expect(state.active).toBe(0);
});

it('releases failed worker slots to pending renders', async () => {
	const start = state.workers.length;
	const results = Promise.allSettled(Array.from({ length: MAX_ACTIVE_CREDIT_RENDERS + 1 }, () => renderCreditTemplate('template', {})));
	await vi.waitFor(() => expect(state.workers.length - start).toBe(MAX_ACTIVE_CREDIT_RENDERS));
	state.workers[start]!.emit('error', new Error('Invalid template'));
	await vi.waitFor(() => expect(state.workers.length - start).toBe(MAX_ACTIVE_CREDIT_RENDERS + 1));
	for (const worker of state.workers.slice(start + 1)) {
		worker.emit('message', { ass: 'valid' });
	}
	const settled = await results;
	expect(settled[0]).toMatchObject({ status: 'rejected', reason: new Error('Invalid template') });
	expect(settled.slice(1)).toEqual(Array.from({ length: MAX_ACTIVE_CREDIT_RENDERS }, () => ({ status: 'fulfilled', value: 'valid' })));
	expect(state.active).toBe(0);
});
