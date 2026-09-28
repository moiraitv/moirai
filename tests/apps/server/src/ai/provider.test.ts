import { expect, it, vi } from 'vitest';
import { AI_REQUEST_TIMEOUT_MS, AI_WEB_SEARCH_MAX_TOOL_CALLS, AI_WEB_SEARCH_OVERAGE_TOLERANCE, requestAiSelectionText } from '@server/ai/provider.js';

const ai = { apiKey: 'test-key', baseUrl: 'https://custom.example.test/compatible/v1/', model: 'configured-model', webSearch: true };
const selection = JSON.stringify({ matches: [{ title: 'Example', year: 2020 }] });
const completed = { status: 'completed', output: [
	{ type: 'reasoning', summary: [] },
	{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Checking the required feature.' }] },
	{ type: 'web_search_call', status: 'completed', action: { type: 'search' } },
	{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: selection }] },
] };

it('uses bounded hosted search on an arbitrary compatible endpoint and reads the final assistant output', async () => {
	const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
		expect(url).toBe('https://custom.example.test/compatible/v1/responses');
		expect(init?.headers).toMatchObject({ authorization: 'Bearer test-key' });
		const body = JSON.parse(String(init?.body));
		expect(body).toMatchObject({
			model: ai.model, store: false, max_tool_calls: AI_WEB_SEARCH_MAX_TOOL_CALLS,
			tools: [{ type: 'web_search', search_context_size: 'low' }],
		});
		expect(body).not.toHaveProperty('text');
		expect(body).not.toHaveProperty('response_format');
		expect(body).not.toHaveProperty('temperature');
		expect(body.input[0].content).toContain(JSON.stringify(['Example', 2020, 'movie', ['Science Fiction']]));
		expect(body).not.toHaveProperty('messages');
		return Response.json(completed);
	});
	const result = JSON.parse(await requestAiSelectionText(ai, [{ role: 'user', content: JSON.stringify(['Example', 2020, 'movie', ['Science Fiction']]) }], fetchImpl)).matches;
	expect(result).toEqual([{ title: 'Example', year: 2020 }]);
	expect(fetchImpl).toHaveBeenCalledTimes(1);
});

it('keeps Chat Completions when search is explicitly disabled, regardless of hostname', async () => {
	const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
		expect(url).toBe('https://api.x.ai/v1/chat/completions');
		const body = JSON.parse(String(init?.body));
		expect(body).not.toHaveProperty('tools');
		expect(body).not.toHaveProperty('max_tool_calls');
		expect(body).not.toHaveProperty('temperature');
		return Response.json({ choices: [{ message: { content: selection } }] });
	});
	const config = { apiKey: ai.apiKey, model: ai.model, baseUrl: 'https://api.x.ai/v1',
		webSearch: false };
	expect(await requestAiSelectionText(config, [], fetchImpl)).toBe(selection);
});

it.each(['incomplete', 'failed', 'in_progress'])('rejects %s responses even when they contain parseable text', async status => {
	await expect(requestAiSelectionText(ai, [], async () => Response.json({ ...completed, status })))
		.rejects.toThrow('completed search response');
});

it('rejects search output without a final selection', async () => {
	await expect(requestAiSelectionText(ai, [], async () => Response.json({
		status: 'completed', output: [{ type: 'web_search_call' }],
	}))).rejects.toThrow('selection after searching');
});

it('reports unsupported search without retrying or exposing the provider error body', async () => {
	const fetchImpl = vi.fn<typeof fetch>(async () => new Response('private provider diagnostics', { status: 400 }));
	await expect(requestAiSelectionText(ai, [], fetchImpl)).rejects.toThrow('disable MOIRAI_AI_WEB_SEARCH');
	expect(fetchImpl).toHaveBeenCalledTimes(1);
});

it('sets a bounded request deadline', async () => {
	const timeout = vi.spyOn(AbortSignal, 'timeout');
	try {
		await requestAiSelectionText(ai, [], async (_url, init) => {
			expect(init?.signal).toBeInstanceOf(AbortSignal);
			return Response.json(completed);
		});
		expect(timeout).toHaveBeenCalledWith(AI_REQUEST_TIMEOUT_MS);
	}
	finally {
		timeout.mockRestore();
	}
});

it('does not expose non-JSON provider response content', async () => {
	await expect(requestAiSelectionText(ai, [], async () => new Response('private upstream text')))
		.rejects.toThrow('The AI service returned an invalid response. Generate again.');
});

it('reports streamed search activity and validates the final response across byte boundaries', async () => {
	const progress = vi.fn();
	const events = [
		{ type: 'response.web_search_call.in_progress' },
		{ type: 'response.web_search_call.searching' },
		{ type: 'response.web_search_call.completed' },
		{ type: 'response.completed', response: completed },
	];
	const bytes = new TextEncoder().encode(events.map(event => `data: ${JSON.stringify(event)}\r\n\r\n`).join(''));
	const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
		expect(JSON.parse(String(init?.body)).stream).toBe(true);
		return new Response(new ReadableStream({ start(controller) {
			for (const byte of bytes) {
				controller.enqueue(Uint8Array.of(byte));
			}
			controller.close();
		} }), { headers: { 'content-type': 'text/event-stream' } });
	});
	expect(await requestAiSelectionText(ai, [], fetchImpl, { onProgress: progress })).toBe(selection);
	expect(progress.mock.calls.flat()).toEqual(['searching', 'searching', 'generating']);
});

it.each(['response.failed', 'response.incomplete', 'error', 'response.output_text.delta'])('rejects a stream ending with %s without leaking provider diagnostics', async type => {
	const fetchImpl = vi.fn<typeof fetch>(async () => new Response(
		`data: ${JSON.stringify({ type, message: 'private diagnostics' })}\n\n`,
		{ headers: { 'content-type': 'text/event-stream' } },
	));
	await expect(requestAiSelectionText(ai, [], fetchImpl, { onProgress: vi.fn() }))
		.rejects.toThrow('The AI service did not complete the selection. Generate again.');
});

it('preserves an empty search stream instead of labeling it invalid JSON', async () => {
	await expect(requestAiSelectionText(ai, [], async () => new Response(null, {
		headers: { 'content-type': 'text/event-stream' },
	}), { onProgress: vi.fn() })).rejects.toThrow('The AI service returned an empty response. Generate again.');
});

it('counts a tolerated overage even when a compatible provider reports unfamiliar usage', async () => {
	const usage = vi.fn();
	await expect(requestAiSelectionText(ai, [], async () => Response.json({ ...completed, usage: { input_tokens: 'unknown' } }), {
		maxToolCalls: 0, onUsage: usage,
	})).resolves.toBe(selection);
	expect(usage.mock.calls[0]![0].toolCalls).toBe(1);
});

it('rejects incomplete chat completions even if their text parses as a selection', async () => {
	await expect(requestAiSelectionText({ ...ai, webSearch: false }, [], async () => Response.json({
		choices: [{ message: { content: selection }, finish_reason: 'length' }],
	}))).rejects.toThrow('did not complete');
});


it('rejects reported calls beyond the request allowance plus tolerance', async () => {
	await expect(requestAiSelectionText(ai, [], async () => Response.json({ ...completed, output: [
		...Array.from({ length: AI_WEB_SEARCH_OVERAGE_TOLERANCE + 1 }, () => ({ type: 'web_search_call' })),
		completed.output.at(-1),
	] }), { maxToolCalls: 0 })).rejects.toThrow('allowed search overage');
});
