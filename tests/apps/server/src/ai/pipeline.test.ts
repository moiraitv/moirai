import { expect, it, vi } from 'vitest';
import { generateAiSelection } from '@server/ai/pipeline.js';
import { AI_WEB_SEARCH_MAX_TOOL_CALLS, AI_WEB_SEARCH_OVERAGE_TOLERANCE, AI_REQUEST_TIMEOUT_MS, AI_GENERATION_GRACE_MS } from '@server/ai/provider.js';

const ai = { apiKey: 'test', baseUrl: 'https://provider.test/v1', model: 'test', webSearch: true };
const catalog = Array.from({ length: 1_100 }, (_, i) => ({ id: String(i).padStart(5, '0'), title: `Movie ${i}`, year: 2020, kind: 'movie', genres: [] }));
const discovery = { concepts: ['movies'], constraints: [], candidates: [] };

it('caps confident matches at the requested count and skips further paid batches', async () => {
	let call = 0;
	const metrics = vi.fn();
	const fetchImpl = vi.fn<typeof fetch>(async () => {
		const content = call++ === 0 ? discovery : { matches: Array.from({ length: 60 }, (_, index) => String(index + 1)) };
		return Response.json({ choices: [{ message: { content: JSON.stringify(content) } }] });
	});
	const result = await generateAiSelection({ ...ai, webSearch: false }, 'movies', 'movies', {
		loadCatalog: async () => catalog, loadVectors: async () => ({ vectors: {}, queries: [], available: false, issue: 'timeout' }), fetchImpl, onMetrics: metrics,
	}, {}, 50);
	expect(result.itemIds).toHaveLength(50);
	expect(result.coverage?.reviewedCount).toBe(500);
	expect(result.coverage).toMatchObject({ mediaEmbeddingsAvailable: false, queryEmbeddingsAvailable: false });
	expect(metrics.mock.calls[0]![0]).toMatchObject({ embeddingIssue: 'timeout' });
	expect(fetchImpl).toHaveBeenCalledTimes(2);
});

it('reviews confident matches without search and verifies only uncertain candidates', async () => {
	const bodies: Array<Record<string, any>> = [];
	const metrics = vi.fn();
	const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
		const body = JSON.parse(String(init?.body));
		bodies.push(body);
		const rows = body.input?.[1].content.split('\n').filter((line: string) => line.startsWith('[')) ?? [];
		const refs = rows.map((line: string) => JSON.parse(line)[0]);
		const content = bodies.length === 1 ? discovery : bodies.length <= 3
			? { matches: [refs[0]], uncertain: [refs[1], refs[2]] }
			: { matches: [refs[0]] };
		const calls = bodies.length === 4 ? 2 : 0;
		return Response.json({ status: 'completed', usage: { input_tokens: 10, output_tokens: 5 }, output: [
			...Array.from({ length: calls }, () => ({ type: 'web_search_call' })),
			{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(content) }] },
		] });
	});
	const result = await generateAiSelection(ai, 'movies', 'movies', {
		loadCatalog: async () => catalog, loadVectors: async () => ({ vectors: {}, queries: [], available: false }), fetchImpl, onMetrics: metrics,
	}, {}, 50);
	expect(bodies).toHaveLength(4);
	expect(bodies.map(body => body.max_tool_calls)).toEqual([undefined, undefined, undefined, AI_WEB_SEARCH_MAX_TOOL_CALLS]);
	expect(bodies[0]!).not.toHaveProperty('tools');
	expect(bodies[1]!).not.toHaveProperty('tools');
	expect(bodies[2]!).not.toHaveProperty('tools');
	expect(bodies[3]!.input[1].content.match(/^\[/gmu)).toHaveLength(4);
	expect(result.itemIds).toHaveLength(3);
	expect(result.coverage).toMatchObject({ reviewedCount: 1_000, libraryCount: 1_100, searchBudgetExhausted: false });
	expect(metrics.mock.calls[0]![0]).toMatchObject({ requests: 4, toolCalls: 2,
		requestUsage: [{ phase: 'discovery', toolCalls: 0 }, { phase: 'review', toolCalls: 0 },
			{ phase: 'review', toolCalls: 0 }, { phase: 'verification', requestedToolCalls: AI_WEB_SEARCH_MAX_TOOL_CALLS, toolCalls: 2 }],
	});
});

it('limits verification to 30 ranked uncertain candidates across review batches', async () => {
	const bodies: Array<Record<string, any>> = [];
	const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
		const body = JSON.parse(String(init?.body));
		bodies.push(body);
		const refs = body.input?.[1].content.split('\n').filter((line: string) => line.startsWith('['))
			.map((line: string) => JSON.parse(line)[0]) ?? [];
		const content = bodies.length === 1 ? discovery : bodies.length <= 3
			? { matches: [], uncertain: refs.slice(0, 30) } : { matches: [] };
		return Response.json({ status: 'completed', output: [
			{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(content) }] },
		] });
	});
	await generateAiSelection(ai, 'movies', 'movies', {
		loadCatalog: async () => catalog, loadVectors: async () => ({ vectors: {}, queries: [], available: false }), fetchImpl,
	});
	expect(bodies).toHaveLength(4);
	expect(bodies[3]!.input[1].content.match(/^\[/gmu)).toHaveLength(30);
	expect(bodies[3]!).toHaveProperty('max_tool_calls', AI_WEB_SEARCH_MAX_TOOL_CALLS);
});

it('rejects a provider that searches during discovery', async () => {
	const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ status: 'completed', output: [
		{ type: 'web_search_call' },
		{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(discovery) }] },
	] }));
	await expect(generateAiSelection(ai, 'movies', 'movies', {
		loadCatalog: async () => catalog.slice(0, 1), loadVectors: vi.fn(), fetchImpl,
	})).rejects.toThrow('outside verification');
	expect(fetchImpl).toHaveBeenCalledTimes(1);
});

it.each(['unknown', 'malformed', 'failed'])('rejects a %s later batch without returning partial matches', async failure => {
	let call = 0;
	const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
		const body = JSON.parse(String(init?.body));
		const current = call++;
		if (current === 2 && failure === 'failed') {
			return new Response('', { status: 500 });
		}
		const content = current === 0 ? discovery : current === 2 ? failure === 'unknown' ? { matches: ['999999'] } : {} : { matches: [JSON.parse(body.messages[1].content.split('\n').at(-1))[0]] };
		return Response.json({ choices: [{ message: { content: JSON.stringify(content) } }] });
	});
	await expect(generateAiSelection({ ...ai, webSearch: false }, 'movies', 'movies', {
		loadCatalog: async () => catalog, loadVectors: async () => ({ vectors: {}, queries: [], available: false }), fetchImpl,
	})).rejects.toThrow();
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
			const rejected = expect(result).rejects.toThrow('timed out after five minutes');
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
