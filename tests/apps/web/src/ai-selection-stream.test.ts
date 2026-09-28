import { expect, it, vi } from 'vitest';
import { readAiSelection } from '../../../../apps/web/src/ai-selection-stream';

const result = { itemIds: [], unmatched: [], catalogTruncated: false };

it('reports activity and returns only the validated final result', async () => {
	const progress = vi.fn();
	const response = new Response([
		{ type: 'progress', status: 'generating' },
		{ type: 'progress', status: 'searching' },
		{ type: 'result', result },
	].map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
	expect(await readAiSelection(response, progress)).toEqual(result);
	expect(progress.mock.calls.map(call => call[0])).toEqual(['generating', 'searching']);
});

it('accepts compatible JSON responses', async () => {
	expect(await readAiSelection(Response.json(result))).toEqual(result);
});

it('rejects interrupted streams instead of clearing the selection', async () => {
	await expect(readAiSelection(new Response('data: {"type":"progress","status":"generating"}\n\n', {
		headers: { 'content-type': 'text/event-stream' },
	}))).rejects.toThrow('Generation interrupted');
});

it('surfaces stream errors', async () => {
	await expect(readAiSelection(new Response('data: {"type":"error","message":"Try again."}\n\n', {
		headers: { 'content-type': 'text/event-stream' },
	}))).rejects.toThrow('Try again.');
});
