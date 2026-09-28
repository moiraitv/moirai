import { aiContentSelectionResponseSchema, aiSelectionEventSchema, readEventData } from '@moirai/shared';
import type { AiContentSelectionResponse, AiProgress, AiProgressDetails } from '@moirai/shared';

/** Consume progress without applying partial selections; tolerate servers returning plain JSON. */
export async function readAiSelection(
	response: Response,
	onProgress?: (status: AiProgress, details?: AiProgressDetails) => void,
): Promise<AiContentSelectionResponse> {
	if (!response.headers.get('content-type')?.includes('text/event-stream')) {
		return aiContentSelectionResponseSchema.parse(await response.json());
	}
	if (response.body) {
		for await (const data of readEventData(response.body)) {
			const event = aiSelectionEventSchema.parse(JSON.parse(data));
			if (event.type === 'progress') {
				onProgress?.(event.status, { ...(event.batch ? { batch: event.batch } : {}), ...(event.totalBatches ? { totalBatches: event.totalBatches } : {}) });
			}
			else if (event.type === 'error') {
				throw new Error(event.message);
			}
			else {
				return event.result;
			}
		}
	}
	throw new Error('Generation interrupted. Try again.');
}
