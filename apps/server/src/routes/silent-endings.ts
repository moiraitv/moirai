import type { FastifyInstance } from 'fastify';
import { mediaIssueIgnoreSchema, silentEndingAcceptanceSchema, scanHistorySchema } from '@moirai/shared/api-contracts';
import type { Repository } from '../repository/index.js';
import type { LiveEventHub } from '../operations/live-events.js';
import { apiOperation, idParamsSchema, responseContent } from './contracts.js';
import { parseId } from './params.js';

/** Record reversible media-issue decisions for the current inputs and publish its revised library health. */
export function registerSilentEndingRoutes(app: FastifyInstance, repository: Repository, events: Pick<LiveEventHub, 'publish'>): void {
	app.put('/api/v1/libraries/:id/media-issue', {
		schema: apiOperation({
			operationId: 'setMediaIssueIgnored', tags: ['Library scans'],
			summary: 'Ignore or restore an unchanged media health finding',
			params: idParamsSchema, body: mediaIssueIgnoreSchema,
			response: { 200: responseContent('Updated scan history', 'application/json', scanHistorySchema) },
			errors: [400, 404, 409, 500, 503],
		}),
	}, async request => {
		const id = parseId(request);
		const input = mediaIssueIgnoreSchema.parse(request.body);
		if (!await repository.getLibrary(id)) {
			throw app.httpErrors.notFound('Library not found');
		}
		if (!repository.setMediaIssueIgnored(id, input.path, input.code, input.fingerprint, input.ignored)) {
			throw app.httpErrors.conflict('The finding changed, a scan is running, or the source requires approval. Refresh and try again.');
		}
		events.publish({ type: 'library.changed', data: { libraryId: id, change: 'updated', affectsProgramming: false } });
		return repository.listScans(id);
	});
	app.put('/api/v1/libraries/:id/silent-ending', {
		schema: apiOperation({
			operationId: 'setSilentEndingAcceptance', tags: ['Library scans'],
			summary: 'Accept or restore a silent-ending warning for an unchanged file',
			params: idParamsSchema, body: silentEndingAcceptanceSchema,
			response: { 200: responseContent('Updated scan history', 'application/json', scanHistorySchema) },
			errors: [400, 404, 409, 500, 503],
		}),
	}, async request => {
		const id = parseId(request);
		const input = silentEndingAcceptanceSchema.parse(request.body);
		if (!await repository.getLibrary(id)) {
			throw app.httpErrors.notFound('Library not found');
		}
		if (!repository.setSilentEndingAcceptance(id, input.path, input.fingerprint, input.accepted)) {
			throw app.httpErrors.conflict('The finding changed or a scan is running. Refresh after scanning and try again.');
		}
		events.publish({ type: 'library.changed', data: { libraryId: id, change: 'updated', affectsProgramming: false } });
		return repository.listScans(id);
	});
}
