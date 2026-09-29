import { expect, it, vi } from 'vitest';
import { aiResultOfferLimit } from '@moirai/shared';
import { candidateBatches } from '@server/ai/content-selection.js';
import { runFastLocalReview, type FastReviewOptions } from '@server/ai/fast-local-review.js';

const ai = { apiKey: 'test', baseUrl: 'https://provider.test/v1', model: 'test', webSearch: false };
const catalog = Array.from({ length: 1_000 }, (_, index) => ({ id: String(index).padStart(4, '0'),
	title: `Movie ${index}`, year: 2020, kind: 'movie', genres: [] }));

/** Provide deterministic review inputs without real provider or embedding work. */
function options(fetchImpl: typeof fetch, count = 1_000, signal = AbortSignal.timeout(300_000)): FastReviewOptions {
	return { ai, prompt: 'Halloween films with limited adjacent picks', constraints: [],
		batches: candidateBatches(catalog.slice(0, count), 125), maxResults: 200, started: Date.now(), signal,
		fetchImpl, onRequest: () => {}, onUsage: () => {}, onFatalUsage: () => undefined };
}

/** Read model-visible references without treating the user description as a row. */
function references(init: RequestInit): string[] {
	const body = JSON.parse(String(init.body));
	return body.messages[1].content.split('\n').filter((line: string) => line.startsWith('["'))
		.map((line: string) => JSON.parse(line)[0]);
}

it('reviews every batch despite early over-selection and uses at most two requests at once', async () => {
	let active = 0;
	let peak = 0;
	let reviews = 0;
	const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
		const body = JSON.parse(String(init?.body));
		const final = body.messages[1].content.includes('priorCore');
		active += 1;
		peak = Math.max(peak, active);
		await new Promise(resolve => setTimeout(resolve, 1));
		active -= 1;
		if (!final) {
			reviews += 1;
		}
		return Response.json({ choices: [{ message: { content: JSON.stringify({
			core: final ? references(init!).slice(0, 20) : references(init!), supporting: [],
		}) } }] });
	});
	const result = await runFastLocalReview(options(fetchImpl));
	expect(reviews).toBe(8);
	expect(peak).toBe(2);
	expect(result).toMatchObject({ reviewedCount: 1_000, reviewStoppedEarly: false });
	expect(result.itemIds).toHaveLength(20);
});

it('continues after failed batches and finalizes valid partial results', async () => {
	let release!: () => void;
	const first = new Promise<void>(resolve => {
		release = resolve;
	});
	let reviews = 0;
	const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
		const final = JSON.parse(String(init?.body)).messages[1].content.includes('priorCore');
		if (!final) {
			reviews += 1;
			if (reviews === 1) {
				await first;
				return Response.json({ choices: [{ message: { content: '{"core":["1"],"supporting":[]}' } }] });
			}
			return new Response('', { status: 500 });
		}
		return Response.json({ choices: [{ message: { content: '{"core":["1"],"supporting":[]}' } }] });
	});
	const pending = runFastLocalReview(options(fetchImpl, 500));
	await vi.waitFor(() => expect(reviews).toBe(2));
	release();
	const result = await pending;
	expect(result).toMatchObject({ itemIds: ['0000'], reviewedCount: 125, reviewStoppedEarly: true });
	expect(reviews).toBe(4);
});

it('combines successful batches in candidate order despite out-of-order responses', async () => {
	let release!: () => void;
	const first = new Promise<void>(resolve => {
		release = resolve;
	});
	let reviews = 0;
	const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
		const final = JSON.parse(String(init?.body)).messages[1].content.includes('priorCore');
		if (!final) {
			reviews += 1;
			if (reviews === 1) {
				await first;
			}
		}
		return Response.json({ choices: [{ message: { content: JSON.stringify({
			core: references(init!).slice(0, final ? 2 : 1), supporting: [],
		}) } }] });
	});
	const pending = runFastLocalReview(options(fetchImpl, 250));
	await vi.waitFor(() => expect(reviews).toBe(2));
	release();
	expect(await pending).toMatchObject({ itemIds: ['0000', '0125'], reviewedCount: 250,
		reviewStoppedEarly: false, finalReviewIncomplete: false });
});

it('uses validated review picks when the final response has an unknown reference', async () => {
	const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
		const final = JSON.parse(String(init?.body)).messages[1].content.includes('priorCore');
		return Response.json({ choices: [{ message: { content: final
			? '{"core":["9999"],"supporting":[]}'
			: '{"core":["1"],"supporting":[]}' } }] });
	});
	expect(await runFastLocalReview(options(fetchImpl, 125))).toMatchObject({
		itemIds: ['0000'], reviewedCount: 125, finalReviewIncomplete: true,
	});
});

it('uses validated review picks when the final response contains conflicting JSON objects', async () => {
	const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
		const final = JSON.parse(String(init?.body)).messages[1].content.includes('priorCore');
		return Response.json({ choices: [{ message: { content: final
			? '{"core":["1"],"supporting":[]}\n{"core":["2"],"supporting":[]}'
			: '{"core":["1"],"supporting":[]}' } }] });
	});
	expect(await runFastLocalReview(options(fetchImpl, 125))).toMatchObject({
		itemIds: ['0000'], finalReviewIncomplete: true,
	});
});

it('uses reviewed picks when the final response omits a required tier', async () => {
	const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
		const final = JSON.parse(String(init?.body)).messages[1].content.includes('priorCore');
		return Response.json({ choices: [{ message: { content: final
			? '{"core":["1"]}' : '{"core":["1"],"supporting":[]}' } }] });
	});
	expect(await runFastLocalReview(options(fetchImpl, 125))).toMatchObject({
		itemIds: ['0000'], finalReviewIncomplete: true,
	});
});

it('fails without finalizing if every review fails', async () => {
	const fetchImpl = vi.fn<typeof fetch>(async () => new Response('', { status: 500 }));
	await expect(runFastLocalReview(options(fetchImpl, 250))).rejects.toThrow('HTTP 500');
	expect(fetchImpl).toHaveBeenCalledTimes(2);
});

it('rescues two completed invalid reviews once with 80 candidates and records only validated coverage', async () => {
	let calls = 0;
	const diagnostics: Array<{ phase: string; outcome: string; category?: string }> = [];
	const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
		calls += 1;
		const body = JSON.parse(String(init?.body));
		const refs = references(init!);
		const rescue = body.messages[0].content.startsWith('Select only clearly fitting items');
		const final = body.messages[1].content.includes('priorCore');
		return Response.json({ choices: [{ message: { content: calls <= 2
			? '{"core":["9999"],"supporting":[]}'
			: JSON.stringify({ core: refs.slice(0, 1), supporting: rescue || final ? [] : refs.slice(1, 2) }) } }] });
	});
	const result = await runFastLocalReview({ ...options(fetchImpl, 250), onDiagnostic: value => diagnostics.push(value) });
	expect(result).toMatchObject({ reviewedCount: 80, reviewStoppedEarly: true,
		coreItemIds: ['0000'], supportingItemIds: [], finalReviewIncomplete: false });
	expect(calls).toBe(4);
	expect(diagnostics.filter(value => value.category === 'invalid-selection')).toHaveLength(2);
});

it('does not rescue ambiguous timed-out reviews', async () => {
	const fetchImpl = vi.fn<typeof fetch>(async () => {
		throw new DOMException('timeout', 'TimeoutError');
	});
	await expect(runFastLocalReview(options(fetchImpl, 250))).rejects.toThrow();
	expect(fetchImpl).toHaveBeenCalledTimes(2);
});

it('treats a valid empty final selection as authoritative', async () => {
	const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
		const final = JSON.parse(String(init?.body)).messages[1].content.includes('priorCore');
		return Response.json({ choices: [{ message: { content: final
			? '{"core":[],"supporting":[]}' : '{"core":["1"],"supporting":[]}' } }] });
	});
	expect(await runFastLocalReview(options(fetchImpl, 125))).toMatchObject({
		itemIds: [], finalReviewIncomplete: false,
	});
});

it('returns bounded reviewed picks when the final provider call fails', async () => {
	const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
		const final = JSON.parse(String(init?.body)).messages[1].content.includes('priorCore');
		if (final) {
			return new Response('', { status: 500 });
		}
		return Response.json({ choices: [{ message: { content: JSON.stringify({ core: references(init!), supporting: [] }) } }] });
	});
	const result = await runFastLocalReview({ ...options(fetchImpl, 500), maxResults: 50 });
	expect(result).toMatchObject({ reviewedCount: 500, finalReviewIncomplete: true });
	expect(result.itemIds).toHaveLength(aiResultOfferLimit(50));
});

it('keeps completed reviews when the overall deadline interrupts final refinement', async () => {
	const deadline = new AbortController();
	const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
		const final = JSON.parse(String(init?.body)).messages[1].content.includes('priorCore');
		if (final) {
			deadline.abort();
			throw new Error('deadline');
		}
		return Response.json({ choices: [{ message: { content: '{"core":["1"],"supporting":[]}' } }] });
	});
	expect(await runFastLocalReview(options(fetchImpl, 125, deadline.signal))).toMatchObject({
		itemIds: ['0000'], finalReviewIncomplete: true,
	});
});

it('skips an invalid review batch and continues to later valid batches', async () => {
	let reviews = 0;
	const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
		const final = JSON.parse(String(init?.body)).messages[1].content.includes('priorCore');
		if (!final) {
			reviews += 1;
		}
		const content = reviews === 1 && !final ? '{"core":["9999"],"supporting":[]}'
			: JSON.stringify({ core: references(init!).slice(0, 1), supporting: [] });
		return Response.json({ choices: [{ message: { content } }] });
	});
	const result = await runFastLocalReview(options(fetchImpl, 375));
	expect(reviews).toBe(3);
	expect(result).toMatchObject({ reviewedCount: 250, reviewStoppedEarly: true, finalReviewIncomplete: false });
	expect(result.itemIds).toHaveLength(1);
});

it('accepts echoed candidate objects only when their references are known', async () => {
	const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
		const final = JSON.parse(String(init?.body)).messages[1].content.includes('priorCore');
		return Response.json({ choices: [{ message: { content: final
			? '{"core":["1"],"supporting":[]}'
			: '{"core":[{"reference":"1","title":"Untrusted echo"}],"supporting":[]}' } }] });
	});
	expect((await runFastLocalReview(options(fetchImpl, 125))).itemIds).toEqual(['0000']);
});

it('allows 60 seconds for a review request while retaining 45 seconds for final refinement', async () => {
	const deadlines: number[] = [];
	const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
		deadlines.push(ms);
		return new AbortController().signal;
	});
	const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => Response.json({ choices: [{ message: {
		content: JSON.stringify({ core: references(init!).slice(0, 1), supporting: [] }),
	} }] }));
	try {
		await runFastLocalReview(options(fetchImpl, 125, new AbortController().signal));
		expect(deadlines).toEqual([60_000, 45_000]);
	}
	finally {
		timeout.mockRestore();
	}
});

it('limits supporting selections to the number of direct matches', async () => {
	const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
		const refs = references(init!);
		return Response.json({ choices: [{ message: { content: JSON.stringify({ core: refs.slice(0, 2),
			supporting: refs.slice(2, 12) }) } }] });
	});
	const result = await runFastLocalReview(options(fetchImpl, 125));
	expect(result.itemIds).toHaveLength(4);
	expect(result.coreItemIds).toEqual(result.itemIds.slice(0, 2));
	expect(result.supportingItemIds).toEqual(result.itemIds.slice(2));
});

it('retains model-reported tiers when final refinement falls back', async () => {
	const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
		const refs = references(init!);
		const final = JSON.parse(String(init?.body)).messages[1].content.includes('priorCore');
		return final ? new Response('', { status: 500 }) : Response.json({ choices: [{ message: { content: JSON.stringify({
			core: refs.slice(0, 2), supporting: refs.slice(2, 4),
		}) } }] });
	});
	const result = await runFastLocalReview({ ...options(fetchImpl, 125), maxResults: 3 });
	expect(result).toMatchObject({ coreItemIds: ['0000', '0001'], supportingItemIds: ['0002', '0003'],
		itemIds: ['0000', '0001', '0002', '0003'], finalReviewIncomplete: true });
});

it('keeps a modest overage and trims an extreme overage without rejecting the response', async () => {
	const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => Response.json({ choices: [{ message: {
		content: JSON.stringify({ core: references(init!), supporting: [] }),
	} }] }));
	const result = await runFastLocalReview({ ...options(fetchImpl, 250), maxResults: 50 });
	expect(result.itemIds).toHaveLength(aiResultOfferLimit(50));
	expect(result.finalReviewIncomplete).toBe(false);
});

it('never publishes completed reviews after cancellation', async () => {
	const controller = new AbortController();
	const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
		const final = JSON.parse(String(init?.body)).messages[1].content.includes('priorCore');
		if (final) {
			controller.abort();
		}
		return Response.json({ choices: [{ message: { content: '{"core":["1"],"supporting":[]}' } }] });
	});
	await expect(runFastLocalReview({ ...options(fetchImpl, 125, controller.signal), userSignal: controller.signal }))
		.rejects.toThrow();
});

it('stops starting reviews after the launch cutoff and finalizes completed batches', async () => {
	let now = 0;
	const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
	try {
		let reviews = 0;
		const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
			const final = JSON.parse(String(init?.body)).messages[1].content.includes('priorCore');
			if (!final) {
				reviews += 1;
				if (reviews === 2) {
					now = 210_001;
				}
			}
			return Response.json({ choices: [{ message: { content: JSON.stringify({ core: references(init!).slice(0, 1), supporting: [] }) } }] });
		});
		const result = await runFastLocalReview(options(fetchImpl, 500));
		expect(reviews).toBe(2);
		expect(result).toMatchObject({ reviewedCount: 250, reviewStoppedEarly: true });
	}
	finally {
		clock.mockRestore();
	}
});

it('does not launch a review once the review-end deadline has elapsed', async () => {
	let now = 0;
	const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
	try {
		let reviews = 0;
		const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
			const final = JSON.parse(String(init?.body)).messages[1].content.includes('priorCore');
			if (!final) {
				reviews += 1;
				now = 255_001;
			}
			return Response.json({ choices: [{ message: { content: '{"core":["1"],"supporting":[]}' } }] });
		});
		const result = await runFastLocalReview(options(fetchImpl, 250));
		expect(reviews).toBe(1);
		expect(result).toMatchObject({ reviewedCount: 125, reviewStoppedEarly: true });
	}
	finally {
		clock.mockRestore();
	}
});
