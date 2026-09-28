import { AiSelectionError } from './errors.js';
import { AI_GENERATION_TARGET_MS, readEventData, type AiProgress, type AiProgressDetails } from '@moirai/shared';
import { z } from 'zod';
import type { AppConfig } from '../config.js';

/** Total hosted search calls requested per Generate action, including page opens and finds. */
export const AI_WEB_SEARCH_MAX_TOOL_CALLS = 16;
/** Accept small reported overruns without requesting additional tools or retrying paid work. */
export const AI_WEB_SEARCH_OVERAGE_TOLERANCE = 2;

/** Target generation duration and default standalone provider-request deadline. */
export const AI_REQUEST_TIMEOUT_MS = AI_GENERATION_TARGET_MS;
/** Extra time to finish review after the target duration; no new research requests in this period. */
export const AI_GENERATION_GRACE_MS = 120_000;

/** Optional progress reporting and cancellation for an interactive request. */
export interface AiRequestActivity {
	onProgress?: (status: AiProgress, details?: AiProgressDetails) => void;
	signal?: AbortSignal;
	maxToolCalls?: number;
	onUsage?: (usage: AiRequestUsage) => void;
}

/** Aggregate provider accounting without retaining prompts or returned content. */
export interface AiRequestUsage {
	toolCalls: number;
	inputTokens?: number;
	outputTokens?: number;
}

/** Extract supported usage aliases from compatible providers without estimating missing values. */
function accountUsage(payload: unknown, activity: AiRequestActivity): void {
	const envelope = z.object({ output: z.array(z.object({ type: z.string() })).optional(), usage: z.unknown().optional() }).safeParse(payload);
	if (!envelope.success) {
		return;
	}
	const parsed = z.object({ input_tokens: z.number().nonnegative().optional(), output_tokens: z.number().nonnegative().optional(),
		prompt_tokens: z.number().nonnegative().optional(), completion_tokens: z.number().nonnegative().optional() }).safeParse(envelope.data.usage);
	const usage = parsed.success ? parsed.data : undefined;
	const inputTokens = usage?.input_tokens ?? usage?.prompt_tokens;
	const outputTokens = usage?.output_tokens ?? usage?.completion_tokens;
	const toolCalls = envelope.data.output?.filter(item => item.type === 'web_search_call').length ?? 0;
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
	choices: z.array(z.object({ message: z.object({ content: z.string() }), finish_reason: z.string().nullable().optional() })).min(1),
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

/**
 * Use explicitly enabled Responses search without assuming capabilities from provider identity.
 * The default remains Chat Completions; failures never trigger a second paid request.
 */
export async function requestAiSelectionText(
	ai: NonNullable<AppConfig['ai']>,
	messages: AiMessage[],
	fetchImpl: typeof fetch = fetch,
	activity: AiRequestActivity = {},
): Promise<string> {
	const search = ai.webSearch === true;
	const toolsRemaining = activity.maxToolCalls ?? AI_WEB_SEARCH_MAX_TOOL_CALLS;
	const body = search
		? {
			model: ai.model,
			input: messages,
			...(toolsRemaining > 0 ? { tools: [{ type: 'web_search', search_context_size: 'low' }], max_tool_calls: toolsRemaining } : {}),
			store: false,
			...(activity.onProgress ? { stream: true } : {}),
		}
		: {
			model: ai.model,
			messages,
			response_format: { type: 'json_object' },
		};
	const response = await fetchImpl(`${ai.baseUrl.replace(/\/+$/u, '')}/${search ? 'responses' : 'chat/completions'}`, {
		method: 'POST',
		headers: { authorization: `Bearer ${ai.apiKey}`, 'content-type': 'application/json' },
		body: JSON.stringify(body),
		signal: activity.signal ?? AbortSignal.timeout(AI_REQUEST_TIMEOUT_MS),
	});
	if (!response.ok) {
		const guidance = search && [400, 404, 422].includes(response.status)
			? ' Web search requires an endpoint and model supporting Responses, web_search, and max_tool_calls. Check the configuration or disable MOIRAI_AI_WEB_SEARCH.'
			: [401, 403].includes(response.status)
				? ' Check the configured API key and model access.'
				: '';
		throw new AiSelectionError(`The AI service returned HTTP ${response.status}.${guidance}`);
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
		throw new AiSelectionError('The AI service returned an invalid response. Generate again.');
	}
	accountUsage(payload, activity);
	if (!search) {
		const parsed = chatResponseSchema.safeParse(payload);
		if (!parsed.success) {
			throw new AiSelectionError('The AI service did not return a text completion.');
		}
		const choice = parsed.data.choices[0]!;
		if (choice.finish_reason && choice.finish_reason !== 'stop') {
			throw new AiSelectionError('The AI service did not complete the selection. Generate again.');
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
