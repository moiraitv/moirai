import type { FastifyInstance, RouteHandlerMethod } from 'fastify';
import { finished } from 'node:stream/promises';
import { z } from 'zod';
import {
	FALLBACK_FILLER_MAX_BYTES,
	fallbackFillerStatusSchema,
	fallbackFillerUploadSchema,
} from '@moirai/shared';
import { MediaProbeError } from '../media/media-probe.js';
import { MediaPreviewError, parseMediaRange } from '../media/media-preview.js';
import {
	FallbackFillerValidationError,
	FallbackFillerTooLargeError,
	type FallbackFillerScope,
	type FallbackFillerStore,
	type OpenFallbackFiller,
} from '../playback/fallback-filler-store.js';
import type { LiveEventHub } from '../operations/live-events.js';
import type { Repository } from '../repository/index.js';
import type { PlaybackEngine } from '../playback/playback-engine.js';
import { parseId } from './params.js';
import {
	apiOperation,
	binaryBodySchema,
	emptyResponseSchema,
	idParamsSchema,
	multiContentResponse,
	responseContent,
} from './contracts.js';

/** Supported response types for effective fallback browser previews. */
const fallbackPreviewContent = {
	'video/mp4': binaryBodySchema,
	'video/x-matroska': binaryBodySchema,
	'video/webm': binaryBodySchema,
	'video/quicktime': binaryBodySchema,
	'video/mp2t': binaryBodySchema,
	'video/mpeg': binaryBodySchema,
	'video/x-msvideo': binaryBodySchema,
	'application/octet-stream': binaryBodySchema,
};

/** Document the required file while accepting Fastify's null placeholder for a streamed body. */
const streamedFallbackFillerUploadSchema = z.preprocess(
	(value) => value === null ? undefined : value,
	fallbackFillerUploadSchema.optional(),
);

/** Services used to manage global and channel-specific playback safety media. */
interface FallbackFillerRouteDependencies {
	repository: Repository;
	events: LiveEventHub;
	fallbackFillers: FallbackFillerStore;
	playback: PlaybackEngine;
}

/** Return a channel scope only after verifying that its owner still exists. */
async function channelScope(
	app: FastifyInstance,
	repository: Repository,
	request: Parameters<typeof parseId>[0],
): Promise<Extract<FallbackFillerScope, { type: 'channel' }>> {
	const channelId = parseId(request);
	if (!(await repository.getChannel(channelId))) {
		throw app.httpErrors.notFound('Channel not found');
	}
	return { type: 'channel', channelId };
}

/** Convert expected upload-validation failures into stable client errors. */
function uploadError(app: FastifyInstance, error: unknown): never {
	if (error instanceof FallbackFillerTooLargeError) {
		throw app.httpErrors.payloadTooLarge(error.message);
	}
	if (
		error instanceof MediaProbeError
		&& ['executable-unavailable', 'resource-exhausted', 'timed-out'].includes(error.code)
	) {
		throw app.httpErrors.serviceUnavailable(error.message);
	}
	if (error instanceof FallbackFillerValidationError || error instanceof MediaProbeError) {
		throw app.httpErrors.unprocessableEntity(error.message);
	}
	throw error;
}

/** Return the required file part after draining any file rejected for using the wrong field. */
async function fallbackUpload(
	app: FastifyInstance,
	request: Parameters<RouteHandlerMethod>[0],
) {
	let upload;
	try {
		upload = await request.file({
			limits: { files: 1, fields: 0, fileSize: FALLBACK_FILLER_MAX_BYTES },
		});
	}
	catch (error) {
		if (error instanceof app.multipartErrors.RequestFileTooLargeError) {
			throw app.httpErrors.createError(413, 'Fallback filler cannot exceed 512 MiB');
		}
		throw error;
	}
	if (!upload) {
		throw app.httpErrors.badRequest('Provide one video file in the file field');
	}
	if (upload.fieldname !== 'file') {
		upload.file.resume();
		await finished(upload.file).catch(() => undefined);
		throw app.httpErrors.badRequest('Provide one video file in the file field');
	}
	return upload;
}

/** Stream one effective fallback with standard browser byte-range semantics. */
function previewHandler(
	openFallback: (request: Parameters<RouteHandlerMethod>[0]) => Promise<OpenFallbackFiller>,
): RouteHandlerMethod {
	return async (request, reply) => {
		const opened = await openFallback(request);
		let range;
		try {
			range = parseMediaRange(request.headers.range, opened.size);
		}
		catch (error) {
			await opened.handle.close().catch(() => undefined);
			if (error instanceof MediaPreviewError && error.statusCode === 416) {
				return reply
					.status(416)
					.header('Accept-Ranges', 'bytes')
					.header('Content-Range', `bytes */${opened.size}`)
					.send();
			}
			throw error;
		}
		const response = reply
			.type(opened.asset.contentType)
			.header('Accept-Ranges', 'bytes')
			.header('Cache-Control', 'private, no-store')
			.header('Last-Modified', opened.mtime.toUTCString());
		if (range) {
			response
				.status(206)
				.header('Content-Length', String(range.end - range.start + 1))
				.header('Content-Range', `bytes ${range.start}-${range.end}/${opened.size}`);
			if (request.method === 'HEAD') {
				await opened.handle.close();
				return response.send();
			}
			return response.send(opened.handle.createReadStream({ start: range.start, end: range.end }));
		}
		response.header('Content-Length', String(opened.size));
		if (request.method === 'HEAD') {
			await opened.handle.close();
			return response.send();
		}
		return response.send(opened.handle.createReadStream());
	};
}

/** Register managed fallback status, upload, removal, and preview operations. */
export function registerFallbackFillerRoutes(
	app: FastifyInstance,
	{ repository, events, fallbackFillers, playback }: FallbackFillerRouteDependencies,
): void {
	const globalScope = async (): Promise<FallbackFillerScope> => ({ type: 'global' });
	const requestedChannelScope = async (request: Parameters<RouteHandlerMethod>[0]): Promise<
		Extract<FallbackFillerScope, { type: 'channel' }>
	> =>
		channelScope(app, repository, request);
	const globalPreview = previewHandler(async () =>
		fallbackFillers.openEffective(await globalScope()));
	const channelPreview = previewHandler(async (request) =>
		fallbackFillers.openEffective(await requestedChannelScope(request)));
	const bundledPreview = previewHandler(async () => fallbackFillers.openBundled());
	const previewResponse = {
		200: multiContentResponse('Complete fallback media stream', fallbackPreviewContent),
		206: multiContentResponse('Requested fallback media byte range', fallbackPreviewContent),
	};

	app.get('/api/v1/playback/fallback-filler', {
		schema: apiOperation({
			operationId: 'getGlobalFallbackFiller',
			tags: ['Playback fallback'],
			summary: 'Read global playback fallback status',
			response: { 200: responseContent('Global fallback status', 'application/json', fallbackFillerStatusSchema) },
			errors: [500, 503],
		}),
	}, async () => fallbackFillers.status({ type: 'global' }));
	app.put('/api/v1/playback/fallback-filler', {
		schema: apiOperation({
			operationId: 'putGlobalFallbackFiller',
			tags: ['Playback fallback'],
			summary: 'Upload a global playback fallback override',
			description: 'Accepts one streamed file with exactly one video stream, at least 30 seconds long, and up to 512 MiB.',
			body: streamedFallbackFillerUploadSchema,
			consumes: ['multipart/form-data'],
			response: { 200: responseContent('Updated global fallback status', 'application/json', fallbackFillerStatusSchema) },
			errors: [400, 413, 422, 500, 503],
		}),
	}, async (request) => {
		const upload = await fallbackUpload(app, request);
		try {
			const status = await fallbackFillers.store(
				{ type: 'global' },
				upload.filename,
				upload.file,
				(activate) => playback.transitionFallbackReplacement(
					null,
					activate,
				),
			);
			events.publish({ type: 'playback.changed', data: { channelId: null, reason: 'fallback-applied' } });
			return status;
		}
		catch (error) {
			return uploadError(app, error);
		}
	});
	app.delete('/api/v1/playback/fallback-filler', {
		schema: apiOperation({
			operationId: 'deleteGlobalFallbackFiller',
			tags: ['Playback fallback'],
			summary: 'Remove the global playback fallback override',
			response: { 200: responseContent('Inherited bundled fallback status', 'application/json', fallbackFillerStatusSchema) },
			errors: [500, 503],
		}),
	}, async () => {
		const previous = await fallbackFillers.status({ type: 'global' });
		const status = await fallbackFillers.remove(
			{ type: 'global' },
			previous.override
				? () => playback.transitionFallbackRemoval(null)
				: undefined,
		);
		if (status.effective.source !== previous.effective.source
			|| status.override?.filename !== previous.override?.filename) {
			events.publish({
				type: 'playback.changed',
				data: { channelId: null, reason: 'fallback-applied' },
			});
		}
		return status;
	});

	app.get('/api/v1/channels/:id/fallback-filler', {
		schema: apiOperation({
			operationId: 'getChannelFallbackFiller',
			tags: ['Playback fallback'],
			summary: 'Read one channel playback fallback status',
			params: idParamsSchema,
			response: { 200: responseContent('Channel fallback status', 'application/json', fallbackFillerStatusSchema) },
			errors: [400, 404, 500, 503],
		}),
	}, async (request) => fallbackFillers.status(await requestedChannelScope(request)));
	app.put('/api/v1/channels/:id/fallback-filler', {
		schema: apiOperation({
			operationId: 'putChannelFallbackFiller',
			tags: ['Playback fallback'],
			summary: 'Upload one channel playback fallback override',
			description: 'Accepts one streamed file with exactly one video stream, at least 30 seconds long, and up to 512 MiB.',
			params: idParamsSchema,
			body: streamedFallbackFillerUploadSchema,
			consumes: ['multipart/form-data'],
			response: { 200: responseContent('Updated channel fallback status', 'application/json', fallbackFillerStatusSchema) },
			errors: [400, 404, 413, 422, 500, 503],
		}),
	}, async (request) => {
		const scope = await requestedChannelScope(request);
		const upload = await fallbackUpload(app, request);
		try {
			const status = await fallbackFillers.store(
				scope,
				upload.filename,
				upload.file,
				(activate) => playback.transitionFallbackReplacement(
					scope.channelId,
					activate,
				),
			);
			events.publish({
				type: 'playback.changed',
				data: { channelId: scope.channelId, reason: 'fallback-applied' },
			});
			return status;
		}
		catch (error) {
			return uploadError(app, error);
		}
	});
	app.delete('/api/v1/channels/:id/fallback-filler', {
		schema: apiOperation({
			operationId: 'deleteChannelFallbackFiller',
			tags: ['Playback fallback'],
			summary: 'Remove one channel playback fallback override',
			params: idParamsSchema,
			response: { 200: responseContent('Inherited channel fallback status', 'application/json', fallbackFillerStatusSchema) },
			errors: [400, 404, 500, 503],
		}),
	}, async (request) => {
		const scope = await requestedChannelScope(request);
		const previous = await fallbackFillers.status(scope);
		const status = await fallbackFillers.remove(
			scope,
			previous.override
				? () => playback.transitionFallbackRemoval(scope.channelId)
				: undefined,
		);
		if (status.effective.source !== previous.effective.source
			|| status.override?.filename !== previous.override?.filename) {
			events.publish({
				type: 'playback.changed',
				data: { channelId: scope.channelId, reason: 'fallback-applied' },
			});
		}
		return status;
	});

	for (const [url, operationPrefix, params, handler] of [
		['/api/v1/playback/fallback-filler/preview', 'Global', undefined, globalPreview],
		['/api/v1/playback/fallback-filler/bundled-preview', 'Bundled', undefined, bundledPreview],
		['/api/v1/channels/:id/fallback-filler/preview', 'Channel', idParamsSchema, channelPreview],
	] as const) {
		const getSchema = apiOperation({
			operationId: `preview${operationPrefix}FallbackFiller`,
			tags: ['Playback fallback'],
			summary: `Stream the effective ${operationPrefix.toLowerCase()} playback fallback`,
			...(params ? { params } : {}),
			headers: z.object({ range: z.string().optional() }).passthrough(),
			response: { ...previewResponse, 416: emptyResponseSchema },
			errors: [400, 404, 500, 503],
		});
		const headSchema = apiOperation({
			operationId: `inspect${operationPrefix}FallbackFiller`,
			tags: ['Playback fallback'],
			summary: `Inspect the effective ${operationPrefix.toLowerCase()} playback fallback`,
			...(params ? { params } : {}),
			headers: z.object({ range: z.string().optional() }).passthrough(),
			response: { 200: emptyResponseSchema, 206: emptyResponseSchema, 416: emptyResponseSchema },
			errors: [400, 404, 500, 503],
		});
		app.get(url, { exposeHeadRoute: false, schema: getSchema }, handler);
		app.head(url, { config: { swagger: { exposeHeadRoute: true } }, schema: headSchema }, handler);
	}
}
