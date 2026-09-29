import { expect, it, vi } from 'vitest';
import { generateAiSelection } from '@server/ai/pipeline.js';
import { AI_WEB_SEARCH_MAX_TOOL_CALLS, AI_WEB_SEARCH_OVERAGE_TOLERANCE, AI_REQUEST_TIMEOUT_MS, AI_GENERATION_GRACE_MS } from '@server/ai/provider.js';

const ai = { apiKey: 'test', baseUrl: 'https://provider.test/v1', model: 'test', webSearch: true };
const catalog = Array.from({ length: 1_100 }, (_, i) => ({ id: String(i).padStart(5, '0'), title: `Movie ${i}`, year: 2020, kind: 'movie', genres: [] }));
const discovery = { concepts: ['movies'], constraints: [], candidates: [] };

it.each([
	{ name: 'invalid DeepSeek-style discovery', first: () => Response.json({ choices: [{ message: { content: '{"concepts":[]}' } }] }) },
	{ name: 'timed-out Grok-style discovery', first: () => {
		throw new DOMException('timeout', 'TimeoutError');
	} },
])('uses local discovery after $name without repeating planning', async ({ first }) => {
	const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
		if (fetchImpl.mock.calls.length === 1) {
			return first();
		}
		const body = JSON.parse(String(init?.body));
		const refs = body.messages[1].content.split('\n').filter((line: string) => line.startsWith('["'))
			.map((line: string) => JSON.parse(line)[0]);
		return Response.json({ choices: [{ message: { content: JSON.stringify({ core: refs.slice(0, 1), supporting: [] }) } }] });
	});
	const metrics = vi.fn();
	const result = await generateAiSelection({ ...ai, webSearch: false }, 'Halloween movies', 'movies', {
		fastLocalReview: true, fetchImpl, onMetrics: metrics,
		loadCatalog: async () => catalog.slice(0, 125),
		loadVectors: async () => ({ vectors: {}, queries: [], available: false }),
	}, {}, 50);
	expect(result.itemIds).toHaveLength(1);
	expect(result.coverage?.localDiscoveryFallback).toBe(true);
	expect(fetchImpl).toHaveBeenCalledTimes(3);
	expect(metrics.mock.calls[0]![0].requestDiagnostics[0]).toMatchObject({ phase: 'discovery',
		outcome: 'failed' });
});

it.each([401, 400, 422])('does not hide HTTP %s configuration or authorization failures with local fallback', async status => {
	const fetchImpl = vi.fn<typeof fetch>(async () => new Response('', { status }));
	await expect(generateAiSelection({ ...ai, webSearch: false }, 'Halloween movies', 'movies', {
		fastLocalReview: true, fetchImpl,
		loadCatalog: async () => catalog.slice(0, 125),
		loadVectors: vi.fn(),
	}, {}, 50)).rejects.toThrow(`HTTP ${status}`);
	expect(fetchImpl).toHaveBeenCalledTimes(1);
});

it('does not continue after a spending refusal or user cancellation during discovery', async () => {
	const refusal = Object.assign(new Error('limit'), { name: 'EvaluationBudgetError' });
	const fetchImpl = vi.fn<typeof fetch>(async () => {
		throw refusal;
	});
	await expect(generateAiSelection({ ...ai, webSearch: false }, 'Halloween movies', 'movies', {
		fastLocalReview: true, fetchImpl,
		loadCatalog: async () => catalog.slice(0, 125), loadVectors: vi.fn(),
	}, {}, 50)).rejects.toBe(refusal);
	expect(fetchImpl).toHaveBeenCalledTimes(1);
	const controller = new AbortController();
	const canceled = vi.fn<typeof fetch>(async () => {
		controller.abort();
		throw new DOMException('cancelled', 'AbortError');
	});
	await expect(generateAiSelection({ ...ai, webSearch: false }, 'Halloween movies', 'movies', {
		fastLocalReview: true, fetchImpl: canceled,
		loadCatalog: async () => catalog.slice(0, 125), loadVectors: vi.fn(),
	}, { signal: controller.signal }, 50)).rejects.toThrow('Generation cancelled');
	expect(canceled).toHaveBeenCalledTimes(1);
});

it('keeps the existing sequential non-search review unless the evaluation path is enabled', async () => {
	let calls = 0;
	let active = 0;
	let maximumActive = 0;
	const fetchImpl = vi.fn<typeof fetch>(async () => {
		const current = calls++;
		if (current === 0) {
			return Response.json({ choices: [{ message: { content: JSON.stringify(discovery) } }] });
		}
		active += 1;
		maximumActive = Math.max(maximumActive, active);
		await new Promise(resolve => setTimeout(resolve, 1));
		active -= 1;
		return Response.json({ choices: [{ message: { content: '{"matches":[]}' } }] });
	});
	const result = await generateAiSelection({ ...ai, webSearch: false }, 'movies', 'movies', {
		loadCatalog: async () => catalog.slice(0, 600),
		loadVectors: async () => ({ vectors: {}, queries: [], available: false }), fetchImpl,
	});
	expect(result.coverage?.reviewedCount).toBe(600);
	expect(result.coverage?.reviewStoppedEarly).toBeUndefined();
	expect(maximumActive).toBe(1);
	expect(fetchImpl).toHaveBeenCalledTimes(3);
});

it('stops before paid work when cancelled during local preparation', async () => {
	const controller = new AbortController();
	const fetchImpl = vi.fn();
	await expect(generateAiSelection(ai, 'movies', 'movies', {
		loadCatalog: async () => {
			controller.abort();
			return catalog; 
		},
		loadVectors: vi.fn(), fetchImpl,
	}, { signal: controller.signal })).rejects.toThrow('Generation cancelled');
	expect(fetchImpl).not.toHaveBeenCalled();
});


it('applies the total deadline while a provider request is pending', async () => {
	vi.useFakeTimers();
	try {
		const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => new Promise((_resolve, reject) => {
			init!.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
		}));
		// Node's native AbortSignal timer is replaced so fake time controls the shared deadline.
		const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
			const controller = new AbortController();
			setTimeout(() => controller.abort(), ms);
			return controller.signal;
		});
		try {
			const result = generateAiSelection(ai, 'movies', 'movies', {
				loadCatalog: async () => catalog, loadVectors: vi.fn(), fetchImpl,
			});
			const rejected = expect(result).rejects.toThrow('timed out after 7 minutes');
			await vi.advanceTimersByTimeAsync(AI_REQUEST_TIMEOUT_MS);
			expect(fetchImpl.mock.calls[0]![1]!.signal!.aborted).toBe(false);
			await vi.advanceTimersByTimeAsync(AI_GENERATION_GRACE_MS);
			await rejected;
			expect(fetchImpl).toHaveBeenCalledTimes(1);
		}
		finally {
			timeout.mockRestore();
		}
	}
	finally {
		vi.useRealTimers();
	}
});

it('uses a saved web-research time limit for the hard deadline', async () => {
	vi.useFakeTimers();
	try {
		const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => new Promise((_resolve, reject) => {
			init!.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
		}));
		const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
			const controller = new AbortController();
			setTimeout(() => controller.abort(), ms);
			return controller.signal;
		});
		try {
			const result = generateAiSelection({ ...ai, webSearchTimeLimitMinutes: 10 }, 'movies', 'movies', {
				loadCatalog: async () => catalog, loadVectors: vi.fn(), fetchImpl,
			});
			const rejected = expect(result).rejects.toThrow('timed out after 10 minutes');
			await vi.advanceTimersByTimeAsync(7 * 60_000);
			expect(fetchImpl.mock.calls[0]![1]!.signal!.aborted).toBe(false);
			await vi.advanceTimersByTimeAsync(3 * 60_000);
			await rejected;
		}
		finally {
			timeout.mockRestore();
		}
	}
	finally {
		vi.useRealTimers();
	}
});

it('caps the bounded non-search review path at five minutes', async () => {
	vi.useFakeTimers();
	try {
		const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({
			choices: [{ message: { content: JSON.stringify(discovery) } }],
		}));
		const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
			const controller = new AbortController();
			setTimeout(() => controller.abort(), ms);
			return controller.signal;
		});
		try {
			const result = generateAiSelection({ ...ai, webSearch: false }, 'movies', 'movies', {
				loadCatalog: async () => catalog, fetchImpl, fastLocalReview: true,
				loadVectors: async (_concepts, signal) => new Promise((_resolve, reject) => {
					signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
				}),
			}, {}, 200);
			const rejected = expect(result).rejects.toThrow('timed out after 5 minutes');
			await vi.advanceTimersByTimeAsync(300_000);
			await rejected;
			expect(fetchImpl).toHaveBeenCalledTimes(1);
		}
		finally {
			timeout.mockRestore();
		}
	}
	finally {
		vi.useRealTimers();
	}
});

it('bounds a larger episode shortlist to eight reviews plus discovery and final refinement', async () => {
	const episodes = Array.from({ length: 1_500 }, (_, index) => ({
		id: String(index).padStart(5, '0'), title: `Episode ${index}`, year: 2020,
		kind: 'episode', genres: [] as string[], series: 'Series', season: 1, episode: index + 1,
	}));
	let calls = 0;
	const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
		calls += 1;
		const body = JSON.parse(String(init?.body));
		const references = body.messages[1].content.split('\n').filter((line: string) => line.startsWith('['))
			.map((line: string) => JSON.parse(line)).filter((row: string[]) => row[0] !== 'series');
		const content = calls === 1 ? discovery : { core: [references[0][0]], supporting: [] };
		expect(body.max_completion_tokens).toBe(4096);
		return Response.json({ choices: [{ message: { content: JSON.stringify(content) } }] });
	});
	const metrics = vi.fn();
	const result = await generateAiSelection({ ...ai, webSearch: false }, 'Episodes', 'tv', {
		loadCatalog: async () => episodes,
		loadVectors: async () => ({ vectors: {}, queries: [], available: false }),
		fetchImpl, fastLocalReview: true, requestOptions: { maxCompletionTokens: 4096 }, onMetrics: metrics,
	}, {}, 200);
	expect(result.coverage).toMatchObject({ reviewedCount: 1_000, reviewStoppedEarly: true });
	expect(result.itemIds.length).toBeLessThanOrEqual(200);
	expect(fetchImpl).toHaveBeenCalledTimes(10);
	expect(metrics.mock.calls[0]![0].requests).toBe(10);
});

it('extends only an explicitly requested offline deadline', async () => {
	vi.useFakeTimers();
	try {
		const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => new Promise((_resolve, reject) => {
			init!.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
		}));
		const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
			const controller = new AbortController();
			setTimeout(() => controller.abort(), ms);
			return controller.signal;
		});
		try {
			const result = generateAiSelection(ai, 'movies', 'movies', {
				loadCatalog: async () => catalog, loadVectors: vi.fn(), fetchImpl, timeoutMs: 15 * 60_000,
			});
			const rejected = expect(result).rejects.toThrow('timed out after 15 minutes');
			await vi.advanceTimersByTimeAsync(AI_REQUEST_TIMEOUT_MS + AI_GENERATION_GRACE_MS);
			expect(fetchImpl.mock.calls[0]![1]!.signal!.aborted).toBe(false);
			await vi.advanceTimersByTimeAsync(10 * 60_000);
			await rejected;
		}
		finally {
			timeout.mockRestore();
		}
	}
	finally {
		vi.useRealTimers();
	}
});


it.each([1, AI_WEB_SEARCH_OVERAGE_TOLERANCE])('accepts a small verification overage without requesting extra calls', async overage => {
	const bodies: Array<Record<string, any>> = [];
	const metrics = vi.fn();
	const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
		const body = JSON.parse(String(init?.body));
		bodies.push(body);
		const ref = body.input?.[1].content.match(/^\["(\d+)",/mu)?.[1];
		const content = bodies.length === 1 ? discovery : bodies.length === 2
			? { matches: [], uncertain: [ref] } : { matches: [ref] };
		const calls = bodies.length === 3 ? AI_WEB_SEARCH_MAX_TOOL_CALLS + overage : 0;
		return Response.json({ status: 'completed', output: [
			...Array.from({ length: calls }, () => ({ type: 'web_search_call' })),
			{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(content) }] },
		] });
	});
	const result = await generateAiSelection(ai, 'movies', 'movies', {
		loadCatalog: async () => catalog.slice(0, 1), loadVectors: async () => ({ vectors: {}, queries: [], available: false }), fetchImpl, onMetrics: metrics,
	});
	expect(result.itemIds).toHaveLength(1);
	expect(bodies.map(body => body.max_tool_calls)).toEqual([undefined, undefined, AI_WEB_SEARCH_MAX_TOOL_CALLS]);
	expect(result.coverage?.searchBudgetExhausted).toBe(true);
	expect(metrics.mock.calls[0]![0]).toMatchObject({ toolCalls: AI_WEB_SEARCH_MAX_TOOL_CALLS + overage, searchBudgetOverrun: true });
});

it('uses Anthropic Messages without search for planning and review, then searches for verification', async () => {
	const bodies: Array<Record<string, any>> = [];
	const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
		expect(url).toBe('https://api.anthropic.com/v1/messages');
		const body = JSON.parse(String(init?.body));
		bodies.push(body);
		const ref = body.messages[0].content.match(/^\["(\d+)",/mu)?.[1];
		const content = bodies.length === 1 ? discovery : bodies.length === 2
			? { matches: [], uncertain: [ref] } : { matches: [ref] };
		return Response.json({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(content) }],
			usage: { server_tool_use: { web_search_requests: bodies.length === 3 ? 2 : 0 } } });
	});
	const result = await generateAiSelection({ ...ai, providerId: 'anthropic',
		baseUrl: 'https://api.anthropic.com/v1', protocol: 'anthropic-messages' }, 'movies', 'movies', {
		loadCatalog: async () => catalog.slice(0, 1),
		loadVectors: async () => ({ vectors: {}, queries: [], available: false }), fetchImpl,
		requestOptions: { protocol: 'anthropic-messages' },
	});
	expect(result.itemIds).toHaveLength(1);
	expect(bodies.map(body => body.tools)).toEqual([undefined, undefined,
		[{ type: 'web_search_20250305', name: 'web_search', max_uses: AI_WEB_SEARCH_MAX_TOOL_CALLS }]]);
});

it('omits candidates left unverified when the verification search exhausts the budget', async () => {
	let calls = 0;
	const fetchImpl = vi.fn<typeof fetch>(async () => {
		const current = calls++;
		const content = current === 0 ? discovery : current === 1 ? { matches: [], uncertain: ['1'] } : { matches: [] };
		return Response.json({ status: 'completed', output: [
			...Array.from({ length: current === 2 ? AI_WEB_SEARCH_MAX_TOOL_CALLS : 0 }, () => ({ type: 'web_search_call' })),
			{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(content) }] },
		] });
	});
	const result = await generateAiSelection(ai, 'movies', 'movies', {
		loadCatalog: async () => catalog.slice(0, 1), loadVectors: async () => ({ vectors: {}, queries: [], available: false }), fetchImpl,
	});
	expect(result.itemIds).toEqual([]);
	expect(result.coverage?.searchBudgetExhausted).toBe(true);
	expect(fetchImpl).toHaveBeenCalledTimes(3);
});

it('omits unverified candidates when no research can start during finishing grace', async () => {
	vi.useFakeTimers();
	try {
		const started = Date.now();
		const bodies: Array<Record<string, unknown>> = [];
		const result = await generateAiSelection(ai, 'movies', 'movies', {
			loadCatalog: async () => catalog.slice(0, 1), loadVectors: async () => ({ vectors: {}, queries: [], available: false }),
			fetchImpl: async (_url, init) => {
				const body = JSON.parse(String(init?.body));
				bodies.push(body);
				if (bodies.length === 2) {
					vi.setSystemTime(started + AI_REQUEST_TIMEOUT_MS + 1);
				}
				const content = bodies.length === 1 ? discovery : { matches: [], uncertain: ['1'] };
				return Response.json({ status: 'completed', output: [
					{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(content) }] },
				] });
			},
		});
		expect(result.itemIds).toEqual([]);
		expect(bodies).toHaveLength(2);
		expect(bodies[1]).not.toHaveProperty('tools');
	}
	finally {
		vi.useRealTimers();
	}
});

it('verifies split episode batches separately so series references are not reused', async () => {
	const episodes = ['Alpha', 'Beta'].map((series, index) => ({
		id: series, title: (index === 0 ? 'A' : 'B').repeat(40_000), year: 2020, kind: 'episode', genres: [] as string[],
		series, seriesYear: 2020, season: 1, episode: 1,
	}));
	const bodies: Array<Record<string, any>> = [];
	const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
		const body = JSON.parse(String(init?.body));
		bodies.push(body);
		const rows = String(body.input?.[1].content ?? '').split('\n').filter(line => line.startsWith('['));
		const refs = rows.map(line => JSON.parse(line)).filter(row => row[0] !== 'series').map(row => row[0]);
		const content = bodies.length === 1 ? discovery : { matches: [], uncertain: refs };
		return Response.json({ status: 'completed', output: [
			{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(content) }] },
		] });
	});
	await generateAiSelection(ai, 'episodes', 'tv', {
		loadCatalog: async () => episodes, loadVectors: async () => ({ vectors: {}, queries: [], available: false }), fetchImpl,
	});
	const verification = bodies.filter(body => body.max_tool_calls !== undefined);
	expect(verification).toHaveLength(2);
	const seriesNames = verification.map(body => {
		const lines = String(body.input[1].content).split('\n').filter(line => line.startsWith('[')).map(line => JSON.parse(line));
		const declared = lines.filter(row => row[0] === 'series');
		expect(declared).toHaveLength(1);
		expect(lines.filter(row => row[0] !== 'series').every(row => row[5] === declared[0][1])).toBe(true);
		return declared[0][2];
	});
	expect(seriesNames).toEqual(['Alpha', 'Beta']);
});
