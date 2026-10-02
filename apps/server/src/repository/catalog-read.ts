import { z } from 'zod';
import { mediaBrowseResultSchema, mediaGenreFacetSchema, mediaSourcePickerResultSchema } from '@moirai/shared/api-contracts';
import type { Repository } from './index.js';
import { timeAsyncPhase, timePhase } from '../scheduling/job-timing.js';

/** Typed paginated catalog reads whose database and serialization work belongs in read workers. */
export type CatalogReadRequest
	= | { kind: 'catalog'; operation: 'browse'; args: Parameters<Repository['browseMedia']> }
		| { kind: 'catalog'; operation: 'genres'; args: Parameters<Repository['listMediaGenres']> }
		| { kind: 'catalog'; operation: 'sources'; args: Parameters<Repository['browseMediaSourceOptions']> };

/** Run the existing query and validate response bytes without repeating work on the HTTP thread. */
export async function catalogRead(repository: Repository, request: CatalogReadRequest): Promise<{ body: string }> {
	const value = await timeAsyncPhase('read', async () => {
		if (request.operation === 'browse') {
			return repository.browseMedia(...request.args);
		}
		if (request.operation === 'genres') {
			return repository.listMediaGenres(...request.args);
		}
		return repository.browseMediaSourceOptions(...request.args);
	});
	return timePhase('serialize', () => {
		const schema = request.operation === 'browse' ? mediaBrowseResultSchema
			: request.operation === 'genres' ? z.array(mediaGenreFacetSchema) : mediaSourcePickerResultSchema;
		return { body: JSON.stringify(schema.parse(value)) };
	});
}
