import { AiInvalidSelectionError, AiProviderHttpError, AiProviderPayloadError, AiSelectionError } from './errors.js';
import { AI_GENERATION_TARGET_MS, AI_WEB_SEARCH_DEFAULT_TIME_LIMIT_MINUTES, readEventData,
	type AiProgress, type AiProgressDetails } from '@moirai/shared';
import { z } from 'zod';
import type { AppConfig } from '../config.js';

/** Requested hosted search uses across one Generate action. */
export const AI_WEB_SEARCH_MAX_TOOL_CALLS = 16;
/** Accept small reported overruns without requesting additional tools or retrying paid work. */
export const AI_WEB_SEARCH_OVERAGE_TOLERANCE = 2;

/** Target generation duration and default standalone provider-request deadline. */
export const AI_REQUEST_TIMEOUT_MS = AI_GENERATION_TARGET_MS;
/** Extra time for in-flight web research after the target; start no new search in this period. */
export const AI_GENERATION_GRACE_MS = AI_WEB_SEARCH_DEFAULT_TIME_LIMIT_MINUTES * 60_000 - AI_REQUEST_TIMEOUT_MS;

/** Optional progress reporting and cancellation for an interactive request. */
export interface AiRequestActivity {
	onProgress?: (status: AiProgress, details?: AiProgressDetails) => void;
	signal?: AbortSignal;
	maxToolCalls?: number;
	onUsage?: (usage: AiRequestUsage) => void;
	maxCompletionTokens?: number;
	reasoningEffort?: 'none' | 'low' | 'medium' | 'high';
	disableThinking?: boolean;
	provider?: { ignore?: string[]; sort?: 'throughput' | 'latency'; allow_fallbacks?: boolean; require_parameters?: boolean };
	protocol?: 'chat-completions' | 'anthropic-messages';
	chatJsonMode?: 'json_object' | 'json_schema' | 'prompt_only';
	jsonSchema?: Record<string, unknown>;
}

/** Bound non-search output while preserving explicitly configured endpoint options. */
export function productionAiRequestOptions(ai: NonNullable<AppConfig['ai']>): Pick<AiRequestActivity, 'maxCompletionTokens' | 'protocol' | 'chatJsonMode' | 'disableThinking' | 'reasoningEffort' | 'provider'> {
	const openRouter = ai.providerId === 'openrouter';
	const tunedOpenRouter = openRouter && ['deepseek/deepseek-v4-pro-0813', 'qwen/qwen3.5-397b-a17b'].includes(ai.model);
	return { maxCompletionTokens: 4_096,
		...(ai.protocol ? { protocol: ai.protocol } : {}),
		...(ai.protocol === 'anthropic-messages' ? { disableThinking: true } : {}),
		...(ai.chatJsonMode ? { chatJsonMode: ai.chatJsonMode } : {}),
		...((ai.providerId === 'openai' && ai.model === 'gpt-6-sol')
			|| (ai.providerId === 'xai' && ai.model === 'grok-4.7') ? { reasoningEffort: 'low' as const } : {}),
		...(openRouter ? { provider: { sort: 'latency' as const, allow_fallbacks: true,
			...(tunedOpenRouter ? { require_parameters: true } : {}),
			...(ai.model === 'qwen/qwen3.5-397b-a17b' ? { ignore: ['Venice'] } : {}) } } : {}),
		...(tunedOpenRouter ? { reasoningEffort: 'none' as const } : {}) };
}

/** Aggregate provider accounting without retaining prompts or returned content. */
export interface AiRequestUsage {
	toolCalls: number;
	inputTokens?: number;
	outputTokens?: number;
}

/** Extract provider-reported search use before falling back to completed tool entries. */
function accountUsage(payload: unknown, activity: AiRequestActivity): void {
	const envelope = z.object({ output: z.array(z.object({ type: z.string() })).optional(), usage: z.unknown().optional() }).safeParse(payload);
	if (!envelope.success) {
		return;
	}
	const parsed = z.object({ input_tokens: z.number().nonnegative().optional(), output_tokens: z.number().nonnegative().optional(),
		prompt_tokens: z.number().nonnegative().optional(), completion_tokens: z.number().nonnegative().optional(),
		num_server_side_tools_used: z.number().int().nonnegative().optional(),
		server_tool_use: z.object({ web_search_requests: z.number().int().nonnegative().optional() }).optional(),
	}).safeParse(envelope.data.usage);
	const usage = parsed.success ? parsed.data : undefined;
	const inputTokens = usage?.input_tokens ?? usage?.prompt_tokens;
	const outputTokens = usage?.output_tokens ?? usage?.completion_tokens;
	const toolCalls = usage?.server_tool_use?.web_search_requests ?? usage?.num_server_side_tools_used
		?? envelope.data.output?.filter(item => item.type === 'web_search_call').length ?? 0;
	activity.onUsage?.({ toolCalls,
		...(inputTokens !== undefined ? { inputTokens } : {}), ...(outputTokens !== undefined ? { outputTokens } : {}) });
	if (toolCalls > (activity.maxToolCalls ?? AI_WEB_SEARCH_MAX_TOOL_CALLS) + AI_WEB_SEARCH_OVERAGE_TOLERANCE) {
		throw new AiSelectionError('The AI service exceeded the allowed search overage. Check the provider’s tool-limit support.');
	}
}

/** Consume provider search events without forwarding provider text or diagnostics. */
async function readSearchResponse(response: Response, activity: AiRequestActivity): Promise<unknown> {
	if (!response.body) {
		throw new AiSelectionError('The AI service returned an empty response. Generate again.');
	}
	for await (const data of readEventData(response.body)) {
		if (data === '[DONE]') {
			break;
		}
		const event = JSON.parse(data);
		if (event.type === 'response.web_search_call.searching' || event.type === 'response.web_search_call.in_progress') {
			activity.onProgress?.('searching');
		}
		else if (event.type === 'response.web_search_call.completed' || event.type === 'response.output_text.delta') {
			activity.onProgress?.('generating');
		}
		else if (event.type === 'response.completed') {
			return event.response;
		}
		else if (['error', 'response.failed', 'response.incomplete'].includes(event.type)) {
			break;
		}
	}
	throw new AiSelectionError('The AI service did not complete the selection. Generate again.');
}

/** Authored instructions and compact catalog sent through either compatible API protocol. */
interface AiMessage {
	role: 'system' | 'user';
	content: string;
}

/** Validate the legacy completion envelope without retaining unrelated provider fields. */
const chatResponseSchema = z.object({
	choices: z.array(z.object({ message: z.object({ content: z.string().nullable().optional() }).optional(),
		finish_reason: z.string().nullable().optional(), error: z.unknown().optional() })).min(1),
});

/** Read assistant text while tolerating reasoning and hosted-tool output entries. */
const responseSchema = z.object({
	status: z.literal('completed'),
	output: z.array(z.object({
		type: z.string(),
		role: z.string().optional(),
		content: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional(),
	})),
});

/** Native Claude messages expose the text block and stop reason directly. */
const anthropicResponseSchema = z.object({
	stop_reason: z.string().nullable(),
	content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
});

/** Extract only a numeric provider status from an embedded error envelope. */
function providerPayloadError(value: unknown): AiProviderPayloadError {
	const parsed = z.object({ status: z.number().int().optional(), code: z.number().int().optional() }).safeParse(value);
	return new AiProviderPayloadError(parsed.success ? parsed.data.status ?? parsed.data.code ?? null : null);
}

/**
 * Use the configured provider's hosted search tool with a per-request call limit.
 * Failures never trigger a second paid request.
 */
export async function requestAiSelectionText(
	ai: NonNullable<AppConfig['ai']>,
	messages: AiMessage[],
	fetchImpl: typeof fetch = fetch,
	activity: AiRequestActivity = {},
): Promise<string> {
	const search = ai.webSearch === true;
	const anthropic = (activity.protocol ?? ai.protocol) === 'anthropic-messages';
	const toolsRemaining = activity.maxToolCalls ?? AI_WEB_SEARCH_MAX_TOOL_CALLS;
	const provider = ai.providerId === 'openrouter' ? { ...activity.provider, sort: 'latency' as const } : activity.provider;
	const body = anthropic
		? {
			model: ai.model,
			max_tokens: activity.maxCompletionTokens ?? 4_096,
			system: messages.filter(message => message.role === 'system').map(message => message.content).join('\n'),
			messages: messages.filter(message => message.role === 'user'),
			...(search && toolsRemaining > 0 ? { tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: toolsRemaining }] } : {}),
			...(activity.disableThinking ? { thinking: { type: 'disabled' } } : {}),
			...(activity.jsonSchema ? { output_config: { format: { type: 'json_schema', schema: activity.jsonSchema } } } : {}),
		}
		: search
			? {
				model: ai.model,
				input: messages,
				...(toolsRemaining > 0 ? { tools: [ai.providerId === 'openrouter'
					? { type: 'openrouter:web_search', parameters: { search_context_size: 'low' } }
					: { type: 'web_search', search_context_size: 'low' }], max_tool_calls: toolsRemaining } : {}),
				store: false,
				...(activity.onProgress ? { stream: true } : {}),
				...(ai.providerId === 'openrouter' ? { provider } : {}),
			}
			: {
				model: ai.model,
				messages,
				...(activity.chatJsonMode === 'prompt_only' ? {}
					: activity.chatJsonMode === 'json_schema' && activity.jsonSchema
						? { response_format: { type: 'json_schema', json_schema: {
							name: 'moirai_selection', strict: true, schema: activity.jsonSchema } } }
						: { response_format: { type: 'json_object' } }),
				...(activity.maxCompletionTokens ? { max_completion_tokens: activity.maxCompletionTokens } : {}),
				...(activity.reasoningEffort ? { reasoning_effort: activity.reasoningEffort } : {}),
				...(activity.disableThinking ? { thinking: { type: 'disabled' } } : {}),
				...(provider ? { provider } : {}),
			};
	const response = await fetchImpl(`${ai.baseUrl.replace(/\/+$/u, '')}/${anthropic ? 'messages' : search ? 'responses' : 'chat/completions'}`, {
		method: 'POST',
		headers: anthropic ? { 'x-api-key': ai.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }
			: { ...(ai.apiKey ? { authorization: `Bearer ${ai.apiKey}` } : {}), 'content-type': 'application/json' },
		body: JSON.stringify(body),
		signal: activity.signal ?? AbortSignal.timeout(AI_REQUEST_TIMEOUT_MS),
	});
	if (!response.ok) {
		const guidance = search && [400, 404, 422].includes(response.status)
			? ' Web research requires a model and account with hosted search access. Check AI Settings or disable web research.'
			: [401, 403].includes(response.status)
				? ' Check the configured API key and model access.'
				: '';
		throw new AiProviderHttpError(`The AI service returned HTTP ${response.status}.${guidance}`, response.status);
	}

	let payload: unknown;
	try {
		payload = search && response.headers.get('content-type')?.includes('text/event-stream')
			? await readSearchResponse(response, activity)
			: await response.json();
	}
	catch (cause) {
		if (cause instanceof AiSelectionError) {
			throw cause;
		}
		if (cause instanceof SyntaxError) {
			throw new AiInvalidSelectionError('The AI service returned an invalid response. Generate again.');
		}
		throw new AiSelectionError('The AI service returned an invalid response. Generate again.');
	}
	accountUsage(payload, activity);
	if (payload && typeof payload === 'object' && 'error' in payload && payload.error != null) {
		throw providerPayloadError(payload.error);
	}
	if (anthropic) {
		const parsed = anthropicResponseSchema.safeParse(payload);
		if (!parsed.success) {
			throw new AiInvalidSelectionError('The AI service did not return a text completion.');
		}
		if (parsed.data.stop_reason !== 'end_turn') {
			throw new AiSelectionError('The AI service did not complete the selection. Generate again.');
		}
		const text = parsed.data.content.filter(part => part.type === 'text').map(part => part.text ?? '').join('');
		if (!text.trim()) {
			throw new AiInvalidSelectionError('The AI service did not return a text completion.');
		}
		return text;
	}
	if (!search) {
		const parsed = chatResponseSchema.safeParse(payload);
		if (!parsed.success) {
			throw new AiInvalidSelectionError('The AI service did not return a text completion.');
		}
		const choice = parsed.data.choices[0]!;
		if (choice.error) {
			throw providerPayloadError(choice.error);
		}
		if (choice.finish_reason && choice.finish_reason !== 'stop') {
			throw new AiSelectionError('The AI service did not complete the selection. Generate again.');
		}
		if (typeof choice.message?.content !== 'string') {
			throw new AiInvalidSelectionError('The AI service did not return a text completion.');
		}
		return choice.message.content;
	}

	const parsed = responseSchema.safeParse(payload);
	if (!parsed.success) {
		throw new AiSelectionError('The AI service did not return a completed search response.');
	}
	const message = parsed.data.output.findLast(item => item.type === 'message' && item.role === 'assistant');
	const text = (message?.content ?? [])
		.filter(part => part.type === 'output_text')
		.map(part => part.text ?? '')
		.join('');
	if (!text.trim()) {
		throw new AiSelectionError('The AI service did not return a selection after searching.');
	}
	return text;
}
