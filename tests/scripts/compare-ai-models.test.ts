import { expect, it, vi } from 'vitest';
import { comparisonRequestOptions, comparisonSchema, configuredModel, overlap, preflightProviders, promptOnlyFetch, type ComparisonRow } from '@scripts/compare-ai-models.js';
import { requestAiSelectionText } from '@server/ai/provider.js';

const model = { apiKey: 'env:TEST_OPENROUTER_KEY', baseUrl: 'https://openrouter.ai/api/v1/',
	model: 'qwen/qwen3.5-397b-a17b', webSearch: false };

it('requires the same prompt and all four settings for every model', () => {
	const input = { libraryId: '00000000-0000-4000-8000-000000000000', prompt: 'Halloween movies', models: [model, { ...model, model: 'second' }] };
	expect(comparisonSchema.parse(input)).toMatchObject({ maxResults: 100, models: [{ webSearch: false }, { model: 'second' }] });
	expect(comparisonSchema.safeParse({ ...input, models: [{ ...model, webSearch: undefined }] }).success).toBe(false);
	expect(comparisonSchema.safeParse({ ...input, prompt: '' }).success).toBe(false);
});

it('resolves a key from the environment without exposing it in configuration errors', () => {
	expect(configuredModel(model, { TEST_OPENROUTER_KEY: 'private-key' })).toEqual({
		apiKey: 'private-key', baseUrl: 'https://openrouter.ai/api/v1', model: model.model, webSearch: false,
	});
	expect(() => configuredModel(model, {})).toThrow('TEST_OPENROUTER_KEY');
});

it('compares completed model selections by item identity', () => {
	const base: ComparisonRow = { name: 'A', model: 'a', webSearch: false, status: 'completed', count: 2,
		durationMs: 100, requests: 2, reportedSearchCalls: 0, inputTokens: null, outputTokens: null,
		reviewedCount: 3, libraryCount: 3, mediaEmbeddingsAvailable: true,
		items: [{ id: 'one', title: 'One', year: 2000, kind: 'movie' }, { id: 'two', title: 'Two', year: 2001, kind: 'movie' }] };
	expect(overlap([base, { ...base, name: 'B', items: [{ id: 'two', title: 'Two', year: 2001, kind: 'movie' }, { id: 'three', title: 'Three', year: 2002, kind: 'movie' }] },
		{ ...base, name: 'C', status: 'failed', items: [] }])).toEqual([{ models: 'A / B', shared: 1, union: 3 }]);
});

it('checks every configured model with a bounded request before generation', async () => {
	const fetchMock = vi.fn(async (...args: [string, RequestInit]) => {
		expect(args[0]).toContain('/chat/completions');
		return Response.json({ choices: [{ message: { content: '{"ok":true}' } }] });
	});
	const fetchImpl = fetchMock as unknown as typeof fetch;
	const models = [
		{ name: 'First', ai: configuredModel(model, { TEST_OPENROUTER_KEY: 'first-key' }) },
		{ name: 'Second', ai: { ...configuredModel(model, { TEST_OPENROUTER_KEY: 'second-key' }), model: 'second' } },
	];

	expect(await preflightProviders(models, fetchImpl)).toEqual([
		{ name: 'First', status: 'ready' }, { name: 'Second', status: 'ready' },
	]);
	expect(fetchMock).toHaveBeenCalledTimes(2);
	const [url, options] = fetchMock.mock.calls[0]!;
	expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
	expect(JSON.parse(options.body as string)).toMatchObject({ model: model.model,
		max_completion_tokens: 32, response_format: { type: 'json_object' } });
});

it('reports failed credentials without skipping later checks or exposing provider bodies', async () => {
	const fetchMock = vi.fn(async (...args: [string, RequestInit]) =>
		(args[1].headers as Record<string, string>).authorization === 'Bearer bad-key'
			? Response.json({ error: { message: 'secret provider detail' } }, { status: 401 })
			: Response.json({ output: [] }));
	const fetchImpl = fetchMock as unknown as typeof fetch;
	const models = [
		{ name: 'Invalid', ai: { ...configuredModel(model, { TEST_OPENROUTER_KEY: 'bad-key' }), webSearch: false } },
		{ name: 'Ready', ai: { ...configuredModel(model, { TEST_OPENROUTER_KEY: 'good-key' }), webSearch: true } },
	];

	expect(await preflightProviders(models, fetchImpl)).toEqual([
		{ name: 'Invalid', status: 'failed', issue: 'HTTP 401' }, { name: 'Ready', status: 'ready' },
	]);
	expect(fetchMock).toHaveBeenCalledTimes(2);
	expect(fetchMock.mock.calls[1]![0]).toBe('https://openrouter.ai/api/v1/responses');
	expect(JSON.parse(fetchMock.mock.calls[1]![1].body as string)).toMatchObject({ max_output_tokens: 32, store: false });
});

it('uses the same prompt-only JSON setting for preflight and production requests', async () => {
	const fetchMock = vi.fn(async (...args: [string, RequestInit]) => {
		const body = JSON.parse(args[1].body as string);
		expect(body).not.toHaveProperty('response_format');
		return Response.json({ choices: [{ message: { content: '{"ok":true}' } }] });
	});
	const fetchImpl = fetchMock as unknown as typeof fetch;
	const ai = configuredModel(model, { TEST_OPENROUTER_KEY: 'test-key' });

	expect(await preflightProviders([{ name: 'Claude', ai, chatJsonMode: 'prompt_only' }], fetchImpl)).toEqual([
		{ name: 'Claude', status: 'ready' },
	]);
	await promptOnlyFetch(fetchImpl)('https://api.anthropic.com/v1/chat/completions', {
		method: 'POST', body: JSON.stringify({ model: 'claude-sonnet-5', response_format: { type: 'json_object' } }),
	});
	expect(fetchMock).toHaveBeenCalledTimes(2);
});

it('preflights an explicitly selected Chat Completions JSON schema', async () => {
	const ai = configuredModel(model, { TEST_OPENROUTER_KEY: 'test-key' });
	const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
		const body = JSON.parse(String(init?.body));
		expect(body.response_format).toMatchObject({ type: 'json_schema', json_schema: {
			strict: true, schema: { required: ['ok'] },
		} });
		return Response.json({ choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }] });
	});
	expect(await preflightProviders([{ name: 'Structured', ai, chatJsonMode: 'json_schema',
		requestOptions: { maxCompletionTokens: 4096 } }], fetchImpl)).toEqual([{ name: 'Structured', status: 'ready' }]);
});

it('preflights native Claude with its protocol and schema before a full selection', async () => {
	const ai = { apiKey: 'test-key', baseUrl: 'https://api.anthropic.com/v1', model: 'claude-sonnet-5', webSearch: false };
	const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
		expect(url).toBe('https://api.anthropic.com/v1/messages');
		expect(init?.headers).toMatchObject({ 'x-api-key': 'test-key' });
		expect(JSON.parse(String(init?.body))).toMatchObject({ max_tokens: 256,
			output_config: { format: { type: 'json_schema' } } });
		return Response.json({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{"ok":true}' }] });
	});
	expect(await preflightProviders([{ name: 'Claude', ai,
		requestOptions: { protocol: 'anthropic-messages', maxCompletionTokens: 4096 } }], fetchImpl))
		.toEqual([{ name: 'Claude', status: 'ready' }]);
});

it('uses explicit protocol and JSON format outside evaluation mode', async () => {
	const anthropic = { apiKey: 'test-key', baseUrl: 'https://api.anthropic.com/v1',
		model: 'claude-sonnet-5', webSearch: false, apiProtocol: 'anthropic-messages' as const };
	const nativeFetch = vi.fn<typeof fetch>(async (url) => {
		expect(url).toBe('https://api.anthropic.com/v1/messages');
		return Response.json({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{"ok":true}' }] });
	});
	const nativeOptions = comparisonRequestOptions(anthropic, false);
	const nativeResult = await requestAiSelectionText(configuredModel(anthropic), [{ role: 'user', content: 'Check.' }], nativeFetch, nativeOptions);
	expect(nativeResult).toBe('{"ok":true}');

	const structured = { ...model, apiKey: 'test-key', chatJsonMode: 'json_schema' as const };
	const structuredFetch = vi.fn<typeof fetch>(async (_url, init) => {
		expect(JSON.parse(String(init?.body)).response_format.type).toBe('json_schema');
		return Response.json({ choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }] });
	});
	const structuredOptions = { ...comparisonRequestOptions(structured, false), jsonSchema: {
		type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false,
	} };
	const structuredResult = await requestAiSelectionText(configuredModel(structured), [{ role: 'user', content: 'Check.' }], structuredFetch, structuredOptions);
	expect(structuredResult).toBe('{"ok":true}');
});

it('preflights native Messages even when research is configured for full runs', async () => {
	const ai = { apiKey: 'test-key', baseUrl: 'https://api.anthropic.com/v1', model: 'claude-sonnet-5', webSearch: true };
	const fetchImpl = vi.fn<typeof fetch>(async url => {
		expect(url).toBe('https://api.anthropic.com/v1/messages');
		return Response.json({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{"ok":true}' }] });
	});
	expect(await preflightProviders([{ name: 'Claude', ai,
		requestOptions: { protocol: 'anthropic-messages' } }], fetchImpl)).toEqual([{ name: 'Claude', status: 'ready' }]);
});
