import type { FastifyInstance } from 'fastify';
import { subtitleSelectionPreviewSchema, subtitleSelectionPreviewResultSchema } from '@moirai/shared';
import type { Repository } from '../repository/index.js';
import { previewSubtitleSelection } from '../playback/subtitle-preview.js';
import { apiOperation, responseContent } from './contracts.js';

/** Register a read-only metadata check for explicitly supplied draft preference layers. */
export function registerSubtitlePreviewRoutes(app: FastifyInstance, { repository }: { repository: Repository }): void {
	app.post('/api/v1/subtitles/selection-preview', { schema: apiOperation({
		operationId: 'previewSubtitleSelection', tags: ['Subtitles'], summary: 'Check draft subtitle rules against indexed media',
		body: subtitleSelectionPreviewSchema,
		response: { 200: responseContent('Metadata-only track selection by physical part', 'application/json', subtitleSelectionPreviewResultSchema) },
		errors: [400, 404, 500, 503],
	}) }, async request => {
		const input = subtitleSelectionPreviewSchema.parse(request.body);
		const item = (await repository.creditTemplates.media([input.mediaItemId])).get(input.mediaItemId);
		if (!item) {
			throw app.httpErrors.notFound('Media item not found');
		}
		return previewSubtitleSelection(item, input);
	});
}
