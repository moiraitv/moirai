import type { FastifyInstance } from 'fastify';
import { GUIDE_ARTWORK_CONTENT_TYPES, GUIDE_ARTWORK_MAX_BYTES, GUIDE_ARTWORK_MAX_DIMENSION, guideArtworkUploadSchema, type ScheduleSlot } from '@moirai/shared';
import { GuideArtworkStore, GuideArtworkValidationError, guideArtworkIds } from '../artwork/guide-artwork-store.js';
import type { Repository } from '../repository/index.js';
import { apiOperation, binaryBodySchema, idParamsSchema, responseContent } from './contracts.js';
import { parseId } from './params.js';

/** Best-effort commit-forward cleanup never turns a committed template save into a failure. */
export async function reconcileGuideArtwork(app: FastifyInstance, store: GuideArtworkStore, repository: Repository): Promise<void> {
	try {
		await store.reconcile(async () => {
			const templates = await repository.listScheduleTemplates();
			return guideArtworkIds(templates.flatMap(template => template.slots));
		});
	}
	catch (error) {
		app.log.warn({ err: error }, 'Unable to reconcile guide artwork');
	}
}

/** Validate new references and serialize commits with orphan cleanup. */
export function saveWithGuideArtwork<T>(
	app: FastifyInstance,
	store: GuideArtworkStore,
	repository: Repository,
	slots: ScheduleSlot[] | undefined,
	save: () => Promise<T>,
): Promise<T> {
	return store.mutate(async () => {
		for (const id of guideArtworkIds(slots ?? [])) {
			if (!(await store.exists(id))) {
				throw app.httpErrors.badRequest('Guide artwork is missing; choose the image again');
			}
		}

		const result = await save();
		await reconcileGuideArtwork(app, store, repository);
		return result;
	});
}

/** Register authenticated raster uploads and public immutable images for guide clients. */
export function registerGuideArtworkRoutes(app: FastifyInstance, { guideArtwork }: { guideArtwork: GuideArtworkStore }): void {
	app.post('/api/v1/guide-artwork', {
		bodyLimit: GUIDE_ARTWORK_MAX_BYTES,
		schema: apiOperation({
			operationId: 'uploadGuideArtwork', tags: ['Guide artwork'], summary: 'Upload artwork for a guide block',
			description: `Accepts still PNG, JPEG, or WebP up to ${GUIDE_ARTWORK_MAX_BYTES} bytes and ${GUIDE_ARTWORK_MAX_DIMENSION} pixels per dimension. Normalizes to metadata-free PNG under the same byte limit.`,
			body: binaryBodySchema, consumes: [...GUIDE_ARTWORK_CONTENT_TYPES],
			response: { 201: responseContent('Immutable artwork reference', 'application/json', guideArtworkUploadSchema) },
			errors: [400, 413, 500],
		}),
	}, async (request, reply) => {
		if (!Buffer.isBuffer(request.body)) {
			throw app.httpErrors.badRequest('Guide artwork must be a PNG, JPEG, or WebP image');
		}
		try {
			const artworkId = await guideArtwork.upload(request.body);
			return reply.status(201).send({ artworkId });
		}
		catch (error) {
			if (error instanceof GuideArtworkValidationError) {
				throw app.httpErrors.badRequest(error.message);
			}
			throw error;
		}
	});
	app.get('/api/v1/guide-artwork/:id', {
		config: { authentication: 'public' },
		schema: apiOperation({
			operationId: 'getGuideArtwork', tags: ['Guide artwork'], summary: 'Read custom guide artwork',
			authentication: 'public', params: idParamsSchema,
			response: { 200: responseContent('Normalized artwork', 'image/png', binaryBodySchema) },
			errors: [400, 404, 500],
		}),
	}, async (request, reply) => {
		const id = parseId(request);
		if (!(await guideArtwork.exists(id))) {
			throw app.httpErrors.notFound('Guide artwork not found');
		}
		return reply.type('image/png').header('Cache-Control', 'public, max-age=31536000, immutable')
			.header('X-Content-Type-Options', 'nosniff').send(guideArtwork.stream(id));
	});
}
