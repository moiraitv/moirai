import type { MediaFetchResponse } from './http.js';
import { MediaServerRequestError } from './http.js';

/**
 * Consume decoded bytes incrementally and cancel as soon as a response exceeds its budget.
 * Body-less scripted responses retain test compatibility; production undici bodies stream.
 */
export async function readMediaBytes(
	response: MediaFetchResponse,
	maximumBytes: number,
	onBytes?: (bytes: number) => void,
): Promise<Buffer> {
	const advertised = Number(response.headers?.get('content-length'));
	if (Number.isFinite(advertised) && advertised > maximumBytes) {
		await response.body?.cancel();
		throw new MediaServerRequestError('Media server response exceeds the byte limit');
	}

	const chunks: Buffer[] = [];
	let consumed = 0;
	/** Account for a chunk before retaining any of its bytes. */
	function accept(bytes: Buffer): void {
		consumed += bytes.byteLength;
		if (consumed > maximumBytes) {
			throw new MediaServerRequestError('Media server response exceeds the byte limit');
		}

		onBytes?.(bytes.byteLength);
		chunks.push(bytes);
	}

	if (!response.body) {
		accept(Buffer.from(await response.text(), 'utf8'));
		return Buffer.concat(chunks, consumed);
	}

	const reader = response.body.getReader();
	try {
		for (;;) {
			const chunk = await reader.read();
			if (chunk.done) {
				break;
			}

			accept(Buffer.from(chunk.value));
		}
	}
	catch (error) {
		await reader.cancel().catch(() => undefined);
		if (error instanceof MediaServerRequestError) {
			throw error;
		}

		throw new MediaServerRequestError('Media server response failed or timed out');
	}
	finally {
		reader.releaseLock();
	}

	return Buffer.concat(chunks, consumed);
}
