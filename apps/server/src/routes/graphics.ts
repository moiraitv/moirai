import { sendWorkerJson, workerRequestSignal } from './worker-response.js';
import type { GraphicsPreviewPosition } from '../graphics/preview-context.js';
import sharp from 'sharp';
import { open } from 'node:fs/promises';
import { MediaPreviewError, parseMediaRange } from '../media/media-preview.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { graphicsAssetSchema, graphicsDraftSchema, graphicsPresetSchema, graphicsPreviewContextQuerySchema, graphicsPreviewContextSchema, graphicsPreviewSchema } from '@moirai/shared';
import type { HttpRouteDependencies } from './index.js';
import { apiOperation, emptyResponseSchema, idParamsSchema, responseContent } from './contracts.js';
import { parseId } from './params.js';
import { GRAPHICS_UPLOAD_LIMIT, graphicsAssetPath, graphicsFolder, removeGraphicsOriginal, storeGraphicsAsset } from '../graphics/assets.js';
import { getGraphicsSampleClip } from '../graphics/sample-clip.js';
import { parseGraphics } from '../graphics/document.js';
import { GraphicsPreviewBusyError, GraphicsPreviewFailure, GraphicsPreviewMediaUnavailable, renderGraphicsPreview } from '../graphics/preview.js';
import { storageFailureMessage } from '../operations/storage-errors.js';

/** Read the entire multipart request before allowing an upload to write an asset. */
async function readGraphicsUpload(app: FastifyInstance, request: FastifyRequest): Promise<{ filename: string; buffer: Buffer }> {
	const message = 'Provide one file in the file field';
	let upload: { filename: string; buffer: Buffer } | undefined;
	try {
		for await (const part of request.parts({ limits: { parts: 1, files: 1, fields: 0, fileSize: GRAPHICS_UPLOAD_LIMIT } })) {
			if (part.type !== 'file' || part.fieldname !== 'file') {
				if (part.type === 'file') {
					part.file.resume();
				}
				throw app.httpErrors.badRequest(message);
			}
			upload = { filename: part.filename, buffer: await part.toBuffer() };
		}
	}
	catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === 'FST_PARTS_LIMIT' || code === 'FST_FILES_LIMIT' || code === 'FST_FIELDS_LIMIT'
			|| code === 'FST_MP_PREMATURE_CLOSE' || code === 'ERR_STREAM_PREMATURE_CLOSE') {
			throw app.httpErrors.badRequest(message);
		}
		throw error;
	}

	if (!upload) {
		throw app.httpErrors.badRequest(message);
	}
	return upload;
}

/** Graphics types served only after successful upload validation. */
const mediaTypes = {
	png: 'image/png', apng: 'image/apng', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
	webm: 'video/webm', mp4: 'video/mp4', ttf: 'font/ttf', otf: 'font/otf',
} as const;

/** Register graphics administration, asset management, and isolated preview operations. */
export function registerGraphicsRoutes(app: FastifyInstance, dependencies: Pick<HttpRouteDependencies, 'repository' | 'config' | 'events' | 'playout' | 'schedulingWorkers'>): void {
	const { repository, config, events, playout, schedulingWorkers } = dependencies;
	const tags = ['Graphics'];
	let uploading = false;

	app.get('/api/v1/graphics/presets', { schema: apiOperation({
		operationId: 'listGraphicsPresets', tags, summary: 'List graphics presets and protected examples',
		response: { 200: responseContent('Graphics presets', 'application/json', z.array(graphicsPresetSchema)) },
		errors: [500, 503],
	}) }, async () => repository.graphics.list());

	app.get('/api/v1/graphics/presets/:id', { schema: apiOperation({
		operationId: 'readGraphicsPreset', tags, summary: 'Read a graphics preset', params: idParamsSchema,
		response: { 200: responseContent('Graphics preset', 'application/json', graphicsPresetSchema) },
		errors: [400, 404, 500, 503],
	}) }, async request => {
		const preset = repository.graphics.get(parseId(request));
		if (!preset) {
			throw app.httpErrors.notFound('Graphics preset not found');
		}
		return preset;
	});

	app.get('/api/v1/graphics/presets/:id/sample-clip', { exposeHeadRoute: false, schema: apiOperation({
		operationId: 'readGraphicsSampleClip', tags, summary: 'Render or read a saved sample channel clip for a graphics preset',
		params: idParamsSchema,
		response: { 200: responseContent('Silent sample channel clip', 'video/mp4', z.string().meta({ format: 'binary' })) },
		errors: [400, 404, 422, 500, 503],
	}) }, async (request, reply) => {
		const preset = repository.graphics.get(parseId(request));
		if (!preset) {
			throw app.httpErrors.notFound('Graphics preset not found');
		}
		try {
			const clip = await getGraphicsSampleClip(config, repository, preset);
			return reply.type('video/mp4').header('Cache-Control', 'no-store').send(clip);
		}
		catch (error) {
			if ((error as { statusCode?: number }).statusCode === 503 || (error as NodeJS.ErrnoException).code === 'ENOENT') {
				throw app.httpErrors.serviceUnavailable('The graphics preview engine is unavailable or busy');
			}
			request.log.warn({ presetId: preset.id }, 'Graphics sample clip failed');
			throw app.httpErrors.unprocessableEntity('The sample clip could not be rendered. Check the preset assets and playback settings.');
		}
	});

	for (const update of [false, true]) {
		app.route({
			method: update ? 'PUT' : 'POST',
			url: update ? '/api/v1/graphics/presets/:id' : '/api/v1/graphics/presets',
			schema: apiOperation({
				operationId: update ? 'updateGraphicsPreset' : 'createGraphicsPreset', tags,
				summary: update ? 'Replace an editable graphics preset' : 'Create a graphics preset',
				...(update ? { params: idParamsSchema } : {}), body: graphicsDraftSchema,
				response: { [update ? 200 : 201]: responseContent('Graphics preset', 'application/json', graphicsPresetSchema) },
				errors: [400, 404, 409, 500, 503],
			}),
			handler: async (request, reply) => {
				const id = update ? parseId(request) : undefined;
				const draft = graphicsDraftSchema.parse(request.body);
				const saved = await repository.graphics.save(draft, id);
				if (update) {
					const channels = await repository.listChannels();
					const scopedChannels = new Set<string>();
					for (const [key, assignment] of repository.graphics.assignments()) {
						if ('presetId' in assignment && assignment.presetId === saved.id) {
							const [scope, id] = key.split(':') as [string, string];
							for (const channelId of repository.graphics.channelsUsingScope(scope, id)) {
								scopedChannels.add(channelId);
							}
						}
					}
					for (const channel of channels) {
						if (scopedChannels.has(channel.id) || channel.graphicsPresetId === saved.id) {
							events.publish({ type: 'channel.changed', data: { channelId: channel.id, change: 'updated' } });
						}
					}
				}
				return reply.status(update ? 200 : 201).send(saved);
			},
		});
	}

	app.delete('/api/v1/graphics/presets/:id', { schema: apiOperation({
		operationId: 'deleteGraphicsPreset', tags, summary: 'Delete an unassigned custom graphics preset', params: idParamsSchema,
		response: { 204: responseContent('Deleted', 'application/json', emptyResponseSchema) },
		errors: [400, 404, 409, 500, 503],
	}) }, async (request, reply) => {
		await repository.graphics.delete(parseId(request));
		return reply.status(204).send();
	});

	app.get('/api/v1/graphics/assets', { schema: apiOperation({
		operationId: 'listGraphicsAssets', tags, summary: 'List managed graphics media and fonts',
		response: { 200: responseContent('Graphics assets', 'application/json', z.array(graphicsAssetSchema)) },
		errors: [500, 503],
	}) }, async () => repository.graphics.assets());

	app.post('/api/v1/graphics/assets', { schema: apiOperation({
		operationId: 'uploadGraphicsAsset', tags, summary: 'Upload a managed graphics image, video, or font',
		consumes: ['multipart/form-data'],
		body: z.preprocess(value => value === null ? undefined : value, z.object({
			file: z.file().describe('Graphics image, video, or font'),
		}).optional()),
		response: { 201: responseContent('Graphics asset', 'application/json', graphicsAssetSchema) },
		errors: [400, 413, 422, 500, 503],
	}) }, async (request, reply) => {
		if (uploading) {
			throw app.httpErrors.serviceUnavailable('Another graphics upload is being checked');
		}
		uploading = true;
		try {
			const { filename, buffer } = await readGraphicsUpload(app, request);
			let asset;
			try {
				asset = await storeGraphicsAsset(graphicsFolder(config.dataDir), filename, buffer, config.ffprobePath);
			}
			catch (error) {
				if (storageFailureMessage(error)) {
					throw error;
				}
				throw app.httpErrors.unprocessableEntity('Unsupported or invalid graphics file. Check the file type and size.');
			}
			await repository.graphics.addAsset(asset);
			return reply.status(201).send(asset);
		}
		finally {
			uploading = false;
		}
	});

	app.get('/api/v1/graphics/assets/:id/poster', { exposeHeadRoute: false, schema: apiOperation({
		operationId: 'readGraphicsAssetPoster', tags, summary: 'Read a still frame from a managed animated image',
		params: idParamsSchema,
		response: { 200: responseContent('Still frame', 'image/png', z.string().meta({ format: 'binary' })) },
		errors: [400, 404, 500, 503],
	}) }, async (request, reply) => {
		const asset = repository.graphics.asset(parseId(request));
		if (!asset || (asset.format !== 'gif' && asset.format !== 'apng')) {
			throw app.httpErrors.notFound('Animated graphics asset not found');
		}
		const source = await graphicsAssetPath(graphicsFolder(config.dataDir), asset);
		const poster = await sharp(source, { pages: 1, limitInputPixels: 3840 * 2160 })
			.timeout({ seconds: 1 }).png().toBuffer();
		return reply.type('image/png').header('Cache-Control', 'private, max-age=86400')
			.header('X-Content-Type-Options', 'nosniff').send(poster);
	});

	app.get('/api/v1/graphics/assets/:id', { schema: apiOperation({
		operationId: 'readGraphicsAsset', tags, summary: 'Read a managed graphics asset', params: idParamsSchema,
		response: {
			200: responseContent('Managed asset', 'application/octet-stream', z.string().meta({ format: 'binary' })),
			206: responseContent('Managed asset byte range', 'application/octet-stream', z.string().meta({ format: 'binary' })),
			416: emptyResponseSchema,
		},
		errors: [400, 404, 500, 503],
	}) }, async (request, reply) => {
		const asset = repository.graphics.asset(parseId(request));
		if (!asset) {
			throw app.httpErrors.notFound('Graphics asset not found');
		}
		const handle = await open(await graphicsAssetPath(graphicsFolder(config.dataDir), asset), 'r');
		let size: number | undefined;
		try {
			({ size } = await handle.stat());
			const range = parseMediaRange(request.headers.range, size);
			reply.type(mediaTypes[asset.format]).header('X-Content-Type-Options', 'nosniff').header('Accept-Ranges', 'bytes');
			if (range) {
				reply.code(206)
					.header('Content-Range', `bytes ${range.start}-${range.end}/${size}`)
					.header('Content-Length', String(range.end - range.start + 1));
			}
			else {
				reply.header('Content-Length', String(size));
			}
			if (request.method === 'HEAD') {
				await handle.close();
				return reply.send();
			}
			return reply.send(handle.createReadStream(range ?? undefined));
		}
		catch (error) {
			await handle.close().catch(() => undefined);
			if (error instanceof MediaPreviewError && error.statusCode === 416) {
				return reply.code(416).header('Accept-Ranges', 'bytes').header('Content-Range', `bytes */${size}`).send();
			}
			throw error;
		}
	});

	app.delete('/api/v1/graphics/assets/:id', { schema: apiOperation({
		operationId: 'deleteGraphicsAsset', tags, summary: 'Retire an unused custom graphics asset', params: idParamsSchema,
		response: { 204: responseContent('Deleted', 'application/json', emptyResponseSchema) },
		errors: [400, 404, 409, 500, 503],
	}) }, async (request, reply) => {
		const retired = await repository.graphics.deleteAsset(parseId(request));
		await removeGraphicsOriginal(graphicsFolder(config.dataDir), retired).catch(error => {
			request.log.warn({ err: error }, 'Retired graphics file cleanup will retry on startup');
		});
		return reply.status(204).send();
	});

	app.get('/api/v1/graphics/preview-context', { schema: apiOperation({
		operationId: 'readGraphicsPreviewContext', tags, summary: 'Read graphics template values at a committed channel position',
		querystring: graphicsPreviewContextQuerySchema,
		response: { 200: responseContent('Path-free preview context', 'application/json', graphicsPreviewContextSchema) },
		errors: [400, 404, 500, 503],
	}) }, async (request, reply) => {
		const query = graphicsPreviewContextQuerySchema.parse(request.query);
		const { body } = await schedulingWorkers.read({
			kind: 'graphics-context', ...query, timeZone: config.timeZone, publicUrl: config.publicUrl,
		}, workerRequestSignal(reply));
		if (body === 'null') {
			throw app.httpErrors.notFound('Channel not found');
		}
		reply.header('Cache-Control', 'no-store');
		return sendWorkerJson(reply, body);
	});

	app.post('/api/v1/graphics/preview', { schema: apiOperation({
		operationId: 'previewGraphics', tags, summary: 'Render a draft preview using the playback engine',
		description: 'When the render slot is occupied, returns HTTP 503 with code graphics_preview_busy and Retry-After: 1. When an attachment target has no measurable bounds, the dependent layer is skipped and the X-Moirai-Graphics-Warning response header explains why.',
		body: graphicsPreviewSchema,
		response: { 200: responseContent('Preview frame', 'image/png', z.string().meta({ format: 'binary' })) },
		errors: [400, 404, 422, 500, 503],
	}) }, async (request, reply) => {
		const { yaml, channelId, elapsedMs, showWallClockLayers } = graphicsPreviewSchema.parse(request.body);
		let document;
		try {
			document = parseGraphics(yaml);
		}
		catch (error) {
			throw app.httpErrors.badRequest((error as Error).message.slice(0, 512));
		}
		try {
			let position: GraphicsPreviewPosition | undefined;
			if (channelId) {
				try {
					const { body } = await schedulingWorkers.read({
						kind: 'graphics-context', channelId, elapsedMs, timeZone: config.timeZone, publicUrl: config.publicUrl,
						render: true, includeContext: document.layers.some(layer => layer.kind === 'text'),
					}, workerRequestSignal(reply));
					position = (JSON.parse(body) as GraphicsPreviewPosition | null) ?? undefined;
				}
				catch (error) {
					if ((error as { statusCode?: number })?.statusCode === 503) {
						throw new GraphicsPreviewFailure('source', 'schedule_unavailable', 'The preview schedule is temporarily unavailable. Try again shortly.', 503);
					}
					throw new GraphicsPreviewFailure('source', 'unexpected', 'Could not read the preview schedule.');
				}
				if (!position) {
					return reply.code(404).send({ code: 'not_found', message: 'Channel not found', requestId: request.id });
				}
			}
			const png = await renderGraphicsPreview(config, repository, document, position?.channel ?? null, elapsedMs, showWallClockLayers, warning => {
				reply.header('X-Moirai-Graphics-Warning', warning);
			}, position);
			return reply.type('image/png').send(png);
		}
		catch (error) {
			if (error instanceof GraphicsPreviewMediaUnavailable) {
				throw app.httpErrors.unprocessableEntity(error.message);
			}
			if (error instanceof GraphicsPreviewBusyError) {
				return reply.header('Retry-After', '1').code(503).send({
					code: 'graphics_preview_busy', message: error.message, requestId: request.id,
				});
			}
			const failure = error instanceof GraphicsPreviewFailure ? error : undefined;
			const reason = failure?.reason ?? 'unexpected';
			request.log.warn({ stage: failure?.stage ?? 'cleanup', reason }, 'Graphics preview failed');
			const message = reason === 'unexpected'
				? `The preview could not be generated. Try again or check the server logs for request ${request.id}.`
				: failure?.message ?? 'The preview could not be generated.';
			return reply.code(failure?.statusCode ?? 422).send({
				code: `graphics_preview_${reason}`, message, requestId: request.id,
			});
		}
	});

	app.get('/api/v1/channels/:id/graphics-issue', { schema: apiOperation({
		operationId: 'readChannelGraphicsIssue', tags, summary: 'Read the latest channel graphics preparation warning', params: idParamsSchema,
		response: { 200: responseContent('Graphics status', 'application/json', z.object({ issue: z.string().nullable() })) },
		errors: [400, 500, 503],
	}) }, async (request) => ({ issue: playout.graphicsIssues.get(parseId(request)) ?? null }));
}
