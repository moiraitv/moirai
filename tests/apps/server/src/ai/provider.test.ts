import { expect, it, vi } from 'vitest';
import { AI_REQUEST_TIMEOUT_MS, AI_WEB_SEARCH_MAX_TOOL_CALLS, AI_WEB_SEARCH_OVERAGE_TOLERANCE, productionAiRequestOptions, requestAiSelectionText } from '@server/ai/provider.js';

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

it('uses OpenRouter hosted search and counts the reported queries', async () => {
	const usage = vi.fn();
	const configured = { ...ai, providerId: 'openrouter' as const, baseUrl: 'https://openrouter.ai/api/v1' };
	const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
		expect(url).toBe('https://openrouter.ai/api/v1/responses');
		expect(JSON.parse(String(init?.body))).toMatchObject({
			max_tool_calls: 4,
			provider: { sort: 'latency' },
			tools: [{ type: 'openrouter:web_search', parameters: { search_context_size: 'low' } }],
		});
		return Response.json({ ...completed, usage: { server_tool_use: { web_search_requests: 3 } } });
	});
	expect(await requestAiSelectionText(configured, [], fetchImpl, { maxToolCalls: 4, onUsage: usage })).toBe(selection);
	expect(usage).toHaveBeenCalledWith(expect.objectContaining({ toolCalls: 3 }));
});

it('uses Anthropic hosted search with its own hard request limit and reported usage', async () => {
	const usage = vi.fn();
	const configured = { ...ai, providerId: 'anthropic' as const, baseUrl: 'https://api.anthropic.com/v1',
		protocol: 'anthropic-messages' as const };
	const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
		expect(url).toBe('https://api.anthropic.com/v1/messages');
		expect(init?.headers).toMatchObject({ 'x-api-key': 'test-key' });
		expect(JSON.parse(String(init?.body))).toMatchObject({
			tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }],
		});
		return Response.json({ stop_reason: 'end_turn', content: [{ type: 'text', text: selection }],
			usage: { input_tokens: 50, output_tokens: 20, server_tool_use: { web_search_requests: 2 } } });
	});
	expect(await requestAiSelectionText(configured, [], fetchImpl, { maxToolCalls: 5, onUsage: usage })).toBe(selection);
	expect(usage).toHaveBeenCalledWith(expect.objectContaining({ toolCalls: 2, inputTokens: 50, outputTokens: 20 }));
});

it('counts xAI server-side search use when no tool entries are returned', async () => {
	const usage = vi.fn();
	await requestAiSelectionText({ ...ai, providerId: 'xai' }, [], async () => Response.json({
		...completed, output: completed.output.filter(item => item.type !== 'web_search_call'),
		usage: { num_server_side_tools_used: 2 },
	}), { onUsage: usage });
	expect(usage).toHaveBeenCalledWith(expect.objectContaining({ toolCalls: 2 }));
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
	await expect(requestAiSelectionText(ai, [], fetchImpl)).rejects.toThrow('disable web research');
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

it('reports an embedded provider failure without exposing its body or retrying', async () => {
	const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ choices: [{ finish_reason: 'error',
		message: { content: null }, error: { message: 'private upstream diagnostic' } }] }));
	await expect(requestAiSelectionText({ ...ai, webSearch: false }, [], fetchImpl))
		.rejects.toThrow('provider could not complete');
	expect(fetchImpl).toHaveBeenCalledTimes(1);
});

it('reports a top-level provider error inside an HTTP 200 response', async () => {
	await expect(requestAiSelectionText({ ...ai, webSearch: false }, [], async () => Response.json({
		error: { message: 'private upstream diagnostic' },
	}))).rejects.toThrow('provider could not complete');
});

it('uses native Claude structured output and accounts for usage', async () => {
	const usage = vi.fn();
	const text = await requestAiSelectionText({ ...ai, webSearch: false, baseUrl: 'https://api.anthropic.com/v1' }, [
		{ role: 'system', content: 'Return matching references.' }, { role: 'user', content: 'Candidate 1' },
	], async (url, init) => {
		expect(url).toBe('https://api.anthropic.com/v1/messages');
		expect(init?.headers).toMatchObject({ 'x-api-key': 'test-key', 'anthropic-version': '2023-06-01' });
		expect(JSON.parse(String(init?.body))).toMatchObject({ max_tokens: 4096, system: 'Return matching references.',
			messages: [{ role: 'user', content: 'Candidate 1' }],
			output_config: { format: { type: 'json_schema', schema: { type: 'object' } } } });
		return Response.json({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{"core":["1"],"supporting":[]}' }],
			usage: { input_tokens: 30, output_tokens: 12 } });
	}, { protocol: 'anthropic-messages', maxCompletionTokens: 4096,
		jsonSchema: { type: 'object' }, onUsage: usage });
	expect(text).toContain('"core"');
	expect(usage).toHaveBeenCalledWith({ toolCalls: 0, inputTokens: 30, outputTokens: 12 });
});

it('rejects native Claude output that stopped at the token limit', async () => {
	await expect(requestAiSelectionText({ ...ai, webSearch: false }, [], async () => Response.json({
		stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"core":[]}' }],
	}), { protocol: 'anthropic-messages', maxCompletionTokens: 4096 })).rejects.toThrow('did not complete');
});

it('sends bounded output and supported routing options only when requested', async () => {
	await requestAiSelectionText({ ...ai, webSearch: false }, [], async (_url, init) => {
		expect(JSON.parse(String(init?.body))).toMatchObject({ max_completion_tokens: 4096,
			reasoning_effort: 'low', provider: { ignore: ['Venice'], sort: 'throughput', allow_fallbacks: true } });
		return Response.json({ choices: [{ message: { content: selection } }] });
	}, { maxCompletionTokens: 4096, reasoningEffort: 'low',
		provider: { ignore: ['Venice'], sort: 'throughput', allow_fallbacks: true } });
});

it('prefers latency for OpenRouter chat requests, including a Qwen routing override', async () => {
	const configured = { ...ai, providerId: 'openrouter' as const, model: 'qwen/qwen3.5-397b-a17b', webSearch: false };
	await requestAiSelectionText(configured, [], async (_url, init) => {
		expect(JSON.parse(String(init?.body))).toMatchObject({
			provider: { ignore: ['Venice'], sort: 'latency', allow_fallbacks: true },
		});
		return Response.json({ choices: [{ message: { content: selection } }] });
	}, productionAiRequestOptions(configured));
});

it('uses bounded production output and omits JSON mode only when configured', async () => {
	const configured = { ...ai, webSearch: false, chatJsonMode: 'prompt_only' as const };
	const options = productionAiRequestOptions(configured);
	await requestAiSelectionText(configured, [], async (_url, init) => {
		const body = JSON.parse(String(init?.body));
		expect(body.max_completion_tokens).toBe(4096);
		expect(body).not.toHaveProperty('response_format');
		return Response.json({ choices: [{ message: { content: selection } }] });
	}, options);
	expect(productionAiRequestOptions({ ...ai, webSearch: false, protocol: 'anthropic-messages' }))
		.toMatchObject({ maxCompletionTokens: 4096, protocol: 'anthropic-messages', disableThinking: true });
});

it('sends an explicit strict JSON schema only when configured', async () => {
	const configured = { ...ai, webSearch: false, chatJsonMode: 'json_schema' as const };
	const options = productionAiRequestOptions(configured);
	await requestAiSelectionText(configured, [], async (_url, init) => {
		const body = JSON.parse(String(init?.body));
		expect(body.response_format).toEqual({ type: 'json_schema', json_schema: {
			name: 'moirai_selection', strict: true,
			schema: { type: 'object', properties: { core: { type: 'array' } } },
		} });
		return Response.json({ choices: [{ message: { content: selection } }] });
	}, { ...options, jsonSchema: { type: 'object', properties: { core: { type: 'array' } } } });
	expect(productionAiRequestOptions({ ...ai, webSearch: false }).chatJsonMode).toBeUndefined();
});


it('rejects reported calls beyond the request allowance plus tolerance', async () => {
	await expect(requestAiSelectionText(ai, [], async () => Response.json({ ...completed, output: [
		...Array.from({ length: AI_WEB_SEARCH_OVERAGE_TOLERANCE + 1 }, () => ({ type: 'web_search_call' })),
		completed.output.at(-1),
	] }), { maxToolCalls: 0 })).rejects.toThrow('allowed search overage');
});
