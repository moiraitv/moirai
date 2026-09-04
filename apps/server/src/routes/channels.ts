import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
	MANAGED_CHANNEL_LOGO_PREFIX,
	channelCreateSchema,
	channelUpdateSchema,
	externalChannelLogoUrl,
	managedChannelLogoId,
	managedChannelLogoUri,
} from '@moirai/shared';
import { channelSchema } from '@moirai/shared/api-contracts';
import { ChannelLogoValidationError, type ChannelLogoStore } from '../artwork/channel-logo-store.js';
import type { LiveEventHub } from '../operations/live-events.js';
import type { Repository } from '../repository/index.js';
import type { FallbackFillerStore } from '../playback/fallback-filler-store.js';
import type { PlaybackEngine } from '../playback/playback-engine.js';
import { parseId } from './params.js';
import {
	apiOperation,
	binaryBodySchema,
	emptyResponseSchema,
	idParamsSchema,
	responseContent,
} from './contracts.js';

/** Services required to manage channels and their logos. */
interface ChannelRouteDependencies {
	repository: Repository;
	events: LiveEventHub;
	channelLogos: ChannelLogoStore;
	fallbackFillers: FallbackFillerStore;
	playback: PlaybackEngine;
}

/** Register channel configuration and managed-logo endpoints. */
export function registerChannelRoutes(
	app: FastifyInstance,
	{ repository, events, channelLogos, fallbackFillers, playback }: ChannelRouteDependencies,
): void {
	// Channel configuration and normalization settings.
	app.get('/api/v1/channels', {
		schema: apiOperation({
			operationId: 'listChannels',
			tags: ['Channels'],
			summary: 'List IPTV channels',
			response: { 200: responseContent('Configured channels', 'application/json', z.array(channelSchema)) },
			errors: [500, 503],
		}),
	}, async () => repository.listChannels());
	const publishChannelChange = (
		channelId: string,
		change: 'created' | 'updated' | 'deleted',
	): void => {
		events.publish({ type: 'channel.changed', data: { channelId, change } });
	};
	app.post('/api/v1/channels', {
		schema: apiOperation({
			operationId: 'createChannel',
			tags: ['Channels'],
			summary: 'Create an IPTV channel',
			body: channelCreateSchema,
			response: { 201: responseContent('Created channel', 'application/json', channelSchema) },
			errors: [400, 409, 500, 503],
		}),
	}, async (request, reply) => {
		const input = channelCreateSchema.parse(request.body);
		if (input.logo?.startsWith(MANAGED_CHANNEL_LOGO_PREFIX)) {
			throw app.httpErrors.badRequest('Managed channel logos must be uploaded after creation');
		}

		const channel = await repository.createChannel(input);
		publishChannelChange(channel.id, 'created');
		return reply.status(201).send(channel);
	});
	app.patch('/api/v1/channels/:id', {
		schema: apiOperation({
			operationId: 'updateChannel',
			tags: ['Channels'],
			summary: 'Update an IPTV channel',
			params: idParamsSchema,
			body: channelUpdateSchema,
			response: { 200: responseContent('Updated channel', 'application/json', channelSchema) },
			errors: [400, 404, 409, 500, 503],
		}),
	}, async (request) => {
		const id = parseId(request);
		const current = await repository.getChannel(id);
		if (!current) {
			throw app.httpErrors.notFound('Channel not found');
		}

		const raw = z.record(z.string(), z.unknown()).parse(request.body);
		if (
			raw.logo === current.logo
			&& typeof current.logo === 'string'
			&& !managedChannelLogoId(current.logo)
			&& !externalChannelLogoUrl(current.logo)
		) {
			delete raw.logo;
		}
		const input = channelUpdateSchema.parse(raw);
		if (
			input.logo?.startsWith(MANAGED_CHANNEL_LOGO_PREFIX)
			&& managedChannelLogoId(input.logo) !== id
		) {
			throw app.httpErrors.badRequest('A managed logo must belong to the channel being updated');
		}

		const channel = await repository.updateChannel(id, input);
		if (!channel) {
			throw app.httpErrors.notFound('Channel not found');
		}

		publishChannelChange(channel.id, 'updated');
		return channel;
	});
	// Managed logo retrieval, validation, and removal.
	app.get('/api/v1/channels/:id/logo', {
		config: { authentication: 'public' },
		schema: apiOperation({
			operationId: 'getChannelLogo',
			tags: ['Channel logos'],
			summary: 'Read a managed channel logo',
			authentication: 'public',
			params: idParamsSchema,
			response: { 200: responseContent('PNG channel logo', 'image/png', binaryBodySchema) },
			errors: [400, 404, 500, 503],
		}),
	}, async (request, reply) => {
		const id = parseId(request);
		const channel = await repository.getChannel(id);
		if (!channel || managedChannelLogoId(channel.logo) !== id || !(await channelLogos.exists(id))) {
			throw app.httpErrors.notFound('Channel logo not found');
		}

		return reply
			.type('image/png')
			.header('Cache-Control', 'private, max-age=3600')
			.header('X-Content-Type-Options', 'nosniff')
			.send(channelLogos.createReadStream(id));
	});
	app.put('/api/v1/channels/:id/logo', {
		schema: apiOperation({
			operationId: 'putChannelLogo',
			tags: ['Channel logos'],
			summary: 'Upload a managed channel logo',
			description: 'Accepts a bounded PNG image and downsizes it to the channel resolution when needed.',
			params: idParamsSchema,
			body: binaryBodySchema,
			consumes: ['image/png'],
			response: { 200: responseContent('Channel with managed logo', 'application/json', channelSchema) },
			errors: [400, 404, 422, 500, 503],
		}),
	}, async (request) => {
		const id = parseId(request);
		const channel = await repository.getChannel(id);
		if (!channel) {
			throw app.httpErrors.notFound('Channel not found');
		}

		if (!Buffer.isBuffer(request.body)) {
			throw app.httpErrors.badRequest('Channel logo body must be an image/png');
		}

		try {
			await channelLogos.store(channel, request.body);
		}
		catch (error) {
			if (error instanceof ChannelLogoValidationError) {
				throw app.httpErrors.badRequest(error.message);
			}

			throw error;
		}
		const updated = await repository.updateChannelLogo(channel, managedChannelLogoUri(id));
		publishChannelChange(updated.id, 'updated');
		return updated;
	});
	app.delete('/api/v1/channels/:id/logo', {
		schema: apiOperation({
			operationId: 'deleteChannelLogo',
			tags: ['Channel logos'],
			summary: 'Remove a managed channel logo',
			params: idParamsSchema,
			response: { 200: responseContent('Channel without managed logo', 'application/json', channelSchema) },
			errors: [400, 404, 500, 503],
		}),
	}, async (request) => {
		const id = parseId(request);
		const channel = await repository.getChannel(id);
		if (!channel) {
			throw app.httpErrors.notFound('Channel not found');
		}

		await channelLogos.remove(id);
		const updated = await repository.updateChannelLogo(channel, null);
		publishChannelChange(updated.id, 'updated');
		return updated;
	});
	// Remove the channel and its dependent runtime state.
	app.delete('/api/v1/channels/:id', {
		schema: apiOperation({
			operationId: 'deleteChannel',
			tags: ['Channels'],
			summary: 'Delete an IPTV channel',
			params: idParamsSchema,
			response: { 204: emptyResponseSchema },
			errors: [400, 404, 409, 500, 503],
		}),
	}, async (request, reply) => {
		const id = parseId(request);
		if (!(await repository.deleteChannel(id))) {
			throw app.httpErrors.notFound('Channel not found');
		}

		let playbackStopped = true;
		try {
			await playback.handleChannelChange(id, true);
		}
		catch (error) {
			playbackStopped = false;
			app.log.warn({ error, channelId: id }, 'Deleted channel playback cleanup failed');
		}
		const cleanup = await Promise.allSettled([
			channelLogos.remove(id),
			...(playbackStopped ? [fallbackFillers.removeChannel(id)] : []),
		]);
		publishChannelChange(id, 'deleted');
		for (const failure of cleanup.filter((result) => result.status === 'rejected')) {
			app.log.warn({ error: failure.reason, channelId: id }, 'Deleted channel cleanup failed');
		}
		return reply.status(204).send();
	});

}
