import { createReadStream } from 'node:fs';
import type { FastifyInstance, RouteHandlerMethod } from 'fastify';
import { z } from 'zod';
import {
	genreMatchSchema,
	MAX_EXPLICIT_MEDIA_GROUPS,
	MAX_EXPLICIT_MEDIA_ITEMS,
	MAX_MEDIA_GENRE_RULES,
	mediaSortSchema,
	sortDirectionSchema,
	validateMediaGenreRules,
} from '@moirai/shared';
import {
	mediaBrowseResultSchema,
	mediaGenreFacetSchema,
	mediaGroupSchema,
	mediaItemDetailSchema,
	mediaItemSchema,
	mediaSourcePickerResultSchema,
} from '@moirai/shared/api-contracts';
import {
	artworkMimeType,
	type ArtworkCache,
	type ArtworkDensity,
	type ArtworkVariant,
} from '../artwork/artwork-cache.js';
import { MediaPreviewError, mediaMimeType, parseMediaRange, resolveMediaFile } from '../media/media-preview.js';
import type { Repository } from '../repository/index.js';
import { openSourceFile, SourceFileError } from '../media/source-file.js';
import { parseId } from './params.js';
import {
	apiOperation,
	binaryBodySchema,
	emptyResponseSchema,
	idParamsSchema,
	multiContentResponse,
	responseContent,
} from './contracts.js';

/** Cache policy for immutable artwork URLs that include a source version. */
const VERSIONED_ARTWORK_CACHE_CONTROL = 'private, max-age=31536000, immutable';

/** Bounded, deduplicated genre keys accepted from repeated query parameters. */
const genreKeysQuerySchema = z
	.union([
		z.string().trim().min(1).max(120),
		z.array(z.string().trim().min(1).max(120)).max(MAX_MEDIA_GENRE_RULES),
	])
	.default([])
	.transform((value) => [...new Set(Array.isArray(value) ? value : [value])]);

/** Filters, sorting, and pagination accepted by catalog browsing. */
const mediaBrowseQuerySchema = z.object({
	parentId: z.uuid().optional(),
	page: z.coerce.number().int().min(1).default(1),
	pageSize: z.coerce.number().int().min(1).max(100).default(48),
	sort: mediaSortSchema.default('title'),
	direction: sortDirectionSchema.default('asc'),
	name: z.string().trim().max(120).default(''),
	releaseYearFrom: z.coerce.number().int().min(1800).max(2200).optional(),
	releaseYearTo: z.coerce.number().int().min(1800).max(2200).optional(),
	addedFrom: z.iso.datetime({ offset: true }).optional(),
	addedBefore: z.iso.datetime({ offset: true }).optional(),
	genres: genreKeysQuerySchema,
	excludedGenres: genreKeysQuerySchema,
	genreMatch: genreMatchSchema.default('all'),
	actor: z.string().trim().max(120).default(''),
	director: z.string().trim().max(120).default(''),
}).superRefine(validateMediaGenreRules);

/** Genre rules used to calculate contextual Match all facet-action counts. */
const mediaGenreFacetQuerySchema = z.object({
	genres: genreKeysQuerySchema,
	excludedGenres: genreKeysQuerySchema,
	genreMatch: genreMatchSchema.default('any'),
}).superRefine(validateMediaGenreRules);

/** Bounded search accepted by scheduling media-source pickers. */
const mediaSourceOptionsQuerySchema = z.object({
	target: z.enum(['items', 'groups']),
	parentId: z.uuid().optional(),
	page: z.coerce.number().int().min(1).default(1),
	pageSize: z.coerce.number().int().min(1).max(100).default(50),
	search: z.string().trim().max(120).default(''),
});

/** Explicit media-item identifiers resolved for a scheduling program. */
const mediaSelectionSchema = z.object({ itemIds: z.array(z.uuid()).max(MAX_EXPLICIT_MEDIA_ITEMS) });

/** Explicit media-group identifiers resolved for a scheduling program. */
const mediaGroupSelectionSchema = z.object({ groupIds: z.array(z.uuid()).max(MAX_EXPLICIT_MEDIA_GROUPS) });

/** Artwork owner and bounded display variant parameters. */
const artworkParamsSchema = z.object({ kind: z.enum(['items', 'groups']), id: z.uuid() });

/** Artwork size variant and display density. */
const artworkQuerySchema = z.object({
	variant: z.enum(['thumb', 'card', 'detail', 'compat']).default('card'),
	dpr: z.coerce.number().int().min(1).max(3).default(1),
});

/** Services required by catalog and media-preview routes. */
interface CatalogRouteDependencies {
	repository: Repository;
	artworkCache: ArtworkCache;
}

/** Register catalog browsing, media preview, and proxied artwork endpoints. */
export function registerCatalogRoutes(
	app: FastifyInstance,
	{ repository, artworkCache }: CatalogRouteDependencies,
): void {
	// Paginated library browsing and filter facets.
	app.get('/api/v1/libraries/:id/media', {
		schema: apiOperation({
			operationId: 'browseLibraryMedia',
			tags: ['Catalog'],
			summary: 'Browse indexed library media',
			params: idParamsSchema,
			querystring: mediaBrowseQuerySchema,
			response: { 200: responseContent('Paginated catalog entries', 'application/json', mediaBrowseResultSchema) },
			errors: [400, 404, 500, 503],
		}),
	}, async (request) => {
		const id = parseId(request);
		const query = mediaBrowseQuerySchema.parse(request.query);
		return repository.browseMedia(id, {
			...query,
			parentId: query.parentId ?? null,
			releaseYearFrom: query.releaseYearFrom ?? null,
			releaseYearTo: query.releaseYearTo ?? null,
			addedFrom: query.addedFrom ?? null,
			addedBefore: query.addedBefore ?? null,
		});
	});
	app.get('/api/v1/libraries/:id/media-genres', {
		schema: apiOperation({
			operationId: 'listLibraryGenres',
			tags: ['Catalog'],
			summary: 'List indexed library genres',
			params: idParamsSchema,
			querystring: mediaGenreFacetQuerySchema,
			response: { 200: responseContent('Normalized genre facets', 'application/json', z.array(mediaGenreFacetSchema)) },
			errors: [400, 404, 500, 503],
		}),
	}, async (request) => {
		const query = mediaGenreFacetQuerySchema.parse(request.query);
		return repository.listMediaGenres(
			parseId(request),
			query.genreMatch === 'all'
				? { genres: query.genres, excludedGenres: query.excludedGenres }
				: null,
		);
	});
	// Bounded source-picker searches for program editing.
	app.get('/api/v1/libraries/:id/media-source-options', {
		schema: apiOperation({
			operationId: 'searchMediaSourceOptions',
			tags: ['Catalog'],
			summary: 'Search scheduling media sources',
			params: idParamsSchema,
			querystring: mediaSourceOptionsQuerySchema,
			response: { 200: responseContent('Bounded source-picker results', 'application/json', mediaSourcePickerResultSchema) },
			errors: [400, 404, 500, 503],
		}),
	}, async (request) => {
		const query = mediaSourceOptionsQuerySchema.parse(request.query);
		return repository.browseMediaSourceOptions(parseId(request), {
			...query,
			parentId: query.parentId ?? null,
		});
	});
	// Resolve explicitly selected item and group summaries in stable request order.
	app.post('/api/v1/libraries/:id/media-selection', {
		schema: apiOperation({
			operationId: 'resolveMediaSelection',
			tags: ['Catalog'],
			summary: 'Resolve selected media items',
			params: idParamsSchema,
			body: mediaSelectionSchema,
			response: { 200: responseContent('Selected media in request order', 'application/json', z.array(mediaItemSchema)) },
			errors: [400, 404, 500, 503],
		}),
	}, async (request) => {
		const itemIds = mediaSelectionSchema.parse(request.body).itemIds;
		return repository.listMediaItemsByIds(parseId(request), itemIds);
	});
	app.post('/api/v1/libraries/:id/media-group-selection', {
		schema: apiOperation({
			operationId: 'resolveMediaGroupSelection',
			tags: ['Catalog'],
			summary: 'Resolve selected media groups',
			params: idParamsSchema,
			body: mediaGroupSelectionSchema,
			response: { 200: responseContent('Selected groups in request order', 'application/json', z.array(mediaGroupSchema)) },
			errors: [400, 404, 500, 503],
		}),
	}, async (request) => {
		const groupIds = mediaGroupSelectionSchema.parse(request.body).groupIds;
		return repository.listMediaGroupsByIds(parseId(request), groupIds);
	});
	// Media details and browser-seekable preview playback.
	app.get('/api/v1/media/:id', {
		schema: apiOperation({
			operationId: 'getMediaItem',
			tags: ['Catalog'],
			summary: 'Read full media metadata',
			params: idParamsSchema,
			response: { 200: responseContent('Media detail and measured playback facts', 'application/json', mediaItemDetailSchema) },
			errors: [400, 404, 500, 503],
		}),
	}, async (request) => {
		const id = parseId(request);
		const item = await repository.getMediaItem(id);
		if (!item) {
			throw app.httpErrors.notFound('Media item not found');
		}

		const owner = await repository.getMediaFileOwner(id);
		if (!owner) {
			return item;
		}

		try {
			const source = await resolveMediaFile(owner);
			try {
				return item.parts.length > 1 ? item : { ...item, fileSizeBytes: source.stat.size };
			}
			finally {
				await source.handle.close();
			}
		}
		catch {
			return item;
		}
	});
	/** Stream a validated source file with browser-seekable byte-range support. */
	const serveMediaPreview: RouteHandlerMethod = async (request, reply) => {
		const owner = await repository.getMediaFileOwner(parseId(request));
		if (!owner) {
			throw app.httpErrors.notFound('Media item not found');
		}

		const source = await resolveMediaFile(owner);
		let range;
		try {
			range = parseMediaRange(request.headers.range, source.stat.size);
		}
		catch (error) {
			await source.handle.close().catch(() => undefined);
			if (error instanceof MediaPreviewError && error.statusCode === 416) {
				return reply
					.status(416)
					.header('Accept-Ranges', 'bytes')
					.header('Content-Range', `bytes */${source.stat.size}`)
					.send();
			}

			throw error;
		}
		const replyWithHeaders = reply
			.type(mediaMimeType(source.path))
			.header('Accept-Ranges', 'bytes')
			.header('Cache-Control', 'private, no-store')
			.header('Last-Modified', source.stat.mtime.toUTCString());
		if (range) {
			replyWithHeaders
				.status(206)
				.header('Content-Length', String(range.end - range.start + 1))
				.header('Content-Range', `bytes ${range.start}-${range.end}/${source.stat.size}`);
			if (request.method === 'HEAD') {
				await source.handle.close();
				return replyWithHeaders.send();
			}

			return replyWithHeaders.send(source.handle.createReadStream({
				start: range.start,
				end: range.end,
			}));
		}

		replyWithHeaders.header('Content-Length', String(source.stat.size));
		if (request.method === 'HEAD') {
			await source.handle.close();
			return replyWithHeaders.send();
		}

		return replyWithHeaders.send(source.handle.createReadStream());
	};
	app.get('/api/v1/media/:id/preview', {
		exposeHeadRoute: false,
		schema: apiOperation({
			operationId: 'previewMediaItem',
			tags: ['Catalog'],
			summary: 'Stream a media preview',
			description: 'Supports standard byte ranges for in-browser scrubbing.',
			params: idParamsSchema,
			headers: z.object({ range: z.string().optional() }).passthrough(),
			response: {
				200: multiContentResponse('Complete media stream', {
					'video/mp4': binaryBodySchema,
					'video/x-matroska': binaryBodySchema,
					'video/webm': binaryBodySchema,
					'application/octet-stream': binaryBodySchema,
				}),
				206: multiContentResponse('Requested byte range', {
					'video/mp4': binaryBodySchema,
					'video/x-matroska': binaryBodySchema,
					'video/webm': binaryBodySchema,
					'application/octet-stream': binaryBodySchema,
				}),
				416: emptyResponseSchema,
			},
			errors: [400, 404, 500, 503],
		}),
	}, serveMediaPreview);
	app.head('/api/v1/media/:id/preview', {
		config: { swagger: { exposeHeadRoute: true } },
		schema: apiOperation({
			operationId: 'inspectMediaPreview',
			tags: ['Catalog'],
			summary: 'Inspect media preview headers',
			params: idParamsSchema,
			headers: z.object({ range: z.string().optional() }).passthrough(),
			response: { 200: emptyResponseSchema, 206: emptyResponseSchema, 416: emptyResponseSchema },
			errors: [400, 404, 500, 503],
		}),
	}, serveMediaPreview);
	// Cached, resized artwork variants for catalog cards and detail views.
	app.get('/api/v1/artwork/:kind/:id', {
		config: { authentication: 'public' },
		schema: apiOperation({
			operationId: 'getArtwork',
			tags: ['Catalog artwork'],
			summary: 'Read a cached artwork variant',
			authentication: 'public',
			description: 'Returns a browser-compatible bounded image at 1x, 2x, or 3x display density.',
			params: artworkParamsSchema,
			querystring: artworkQuerySchema,
			response: {
				200: multiContentResponse('Rendered artwork', {
					'image/jpeg': binaryBodySchema,
					'image/png': binaryBodySchema,
					'image/webp': binaryBodySchema,
				}),
			},
			errors: [400, 403, 404, 422, 500, 503],
		}),
	}, async (request, reply) => {
		// Validate the owner and requested bounded display variant.
		const params = artworkParamsSchema.parse(request.params);
		const artworkQuery = artworkQuerySchema.parse(request.query) as {
			variant: ArtworkVariant;
			dpr: ArtworkDensity;
		};
		const owner = await repository.getArtworkOwner(params.kind, params.id);
		const relativePath = owner?.relativePath;
		if (!owner || !relativePath) {
			throw app.httpErrors.notFound('Artwork not found');
		}

		// Serve an exact current cache hit without touching source storage.
		const cacheOwner = { ...owner, relativePath, kind: params.kind, id: params.id };
		const cached = await artworkCache.get(cacheOwner, artworkQuery.variant, artworkQuery.dpr);
		if (cached) {
			return reply
				.type(artworkMimeType(cached))
				.header('Cache-Control', VERSIONED_ARTWORK_CACHE_CONTROL)
				.header('X-Moirai-Artwork-Cache', 'hit')
				.send(createReadStream(cached));
		}

		const library = await repository.getLibrary(owner.libraryId);
		if (!library) {
			throw app.httpErrors.notFound('Library not found');
		}

		// Open the source through the library boundary or fall back to a stale variant.
		let artworkSource: Awaited<ReturnType<typeof openSourceFile>>;
		try {
			artworkSource = await openSourceFile(
				library.sourceConfig.scanRoot,
				relativePath,
				artworkCache.maximumSourceBytes,
			);
		}
		catch (error) {
			const stale = await artworkCache.getStale(cacheOwner, artworkQuery.variant, artworkQuery.dpr);
			if (!stale) {
				if (error instanceof SourceFileError) {
					if (error.reason === 'outside-root' || error.reason === 'symlink') {
						throw app.httpErrors.forbidden('Artwork path is outside the library');
					}

					if (error.reason === 'missing' || error.reason === 'not-file') {
						throw app.httpErrors.notFound('Artwork not found');
					}

					if (error.reason === 'too-large') {
						throw app.httpErrors.unprocessableEntity(
							'Artwork exceeds configured rendering limits',
						);
					}

					throw app.httpErrors.serviceUnavailable('Artwork source is temporarily unavailable');
				}

				throw error;
			}

			request.log.warn(
				{ error, artworkId: params.id },
				'Artwork source unavailable; serving the prior cached version',
			);
			return reply
				.type(artworkMimeType(stale))
				.header('Cache-Control', 'private, max-age=300')
				.header('X-Moirai-Artwork-Cache', 'stale')
				.send(createReadStream(stale));
		}

		// Transform and cache the requested variant while guaranteeing descriptor cleanup.
		let servedArtwork: string | null = null;
		try {
			servedArtwork = await artworkCache.store(
				cacheOwner,
				artworkSource,
				artworkQuery.variant,
				artworkQuery.dpr,
			);
		}
		catch (error) {
			const stale = await artworkCache.getStale(cacheOwner, artworkQuery.variant, artworkQuery.dpr);
			if (stale) {
				request.log.warn({ error }, 'Unable to render artwork; serving a prior cached variant');
				return reply
					.type('image/jpeg')
					.header('Cache-Control', 'private, max-age=300')
					.header('X-Content-Type-Options', 'nosniff')
					.header('X-Moirai-Artwork-Cache', 'stale')
					.send(createReadStream(stale));
			}

			throw error;
		}
		finally {
			await artworkSource.handle.close().catch(() => undefined);
		}
		if (!servedArtwork) {
			throw app.httpErrors.unprocessableEntity('Artwork exceeds configured rendering limits');
		}

		// Serve the newly cached browser-compatible image.
		return reply
			.type('image/jpeg')
			.header('Cache-Control', VERSIONED_ARTWORK_CACHE_CONTROL)
			.header('X-Content-Type-Options', 'nosniff')
			.header('X-Moirai-Artwork-Cache', 'miss')
			.send(createReadStream(servedArtwork));
	});

}
