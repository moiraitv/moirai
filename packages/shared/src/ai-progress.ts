import { z } from 'zod';
import { aiContentSelectionResponseSchema } from './ai-selection.js';

/** Public activity states, independent of provider-specific event names. */
export const aiProgressSchema = z.enum(['generating', 'searching', 'preparing', 'discovering', 'reviewing']);
/** Activity reported while a selection is being generated. */
export type AiProgress = z.infer<typeof aiProgressSchema>;
/** Optional batch position attached to normalized activity events. */
export interface AiProgressDetails {
	batch?: number;
	totalBatches?: number;
}
/** Each SSE data payload; results are sent only after complete validation. */
export const aiSelectionEventSchema = z.discriminatedUnion('type', [
	z.object({ type: z.literal('progress'), status: aiProgressSchema, batch: z.number().int().positive().optional(), totalBatches: z.number().int().positive().optional() }),
	z.object({ type: z.literal('result'), result: aiContentSelectionResponseSchema }),
	z.object({ type: z.literal('error'), message: z.string() }),
]);
/** Shared selection stream contract. */
export type AiSelectionEvent = z.infer<typeof aiSelectionEventSchema>;

/** Read SSE data across UTF-8 chunks, ignoring comments and non-data fields. */
export async function* readEventData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let pending = '';
	let data: string[] = [];
	try {
		while (true) {
			const chunk = await reader.read();
			pending += decoder.decode(chunk.value, { stream: !chunk.done });
			let newline;
			while ((newline = pending.indexOf('\n')) >= 0) {
				const line = pending.slice(0, newline).replace(/\r$/u, '');
				pending = pending.slice(newline + 1);
				if (line === '') {
					if (data.length > 0) {
						yield data.join('\n');
						data = [];
					}
				}
				else if (line.startsWith('data:')) {
					data.push(line.slice(5).replace(/^ /u, ''));
				}
			}
			if (chunk.done) {
				break;
			}
		}
	}
	finally {
		await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}
