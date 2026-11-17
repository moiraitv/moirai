import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
	mediaServerCreateSchema,
	plexPinPollSchema,
	mediaServerClientIdentifierSchema,
	mediaServerProbeSchema,
	mediaServerSignInSchema,
	mediaServerUpdateSchema,
	savedMediaServerProbeSchema,
	type MediaServerUpdate,
	type MediaServerCreate,
} from '@moirai/shared';
import {
	mediaServerCredentialResultSchema,
	mediaServerProbeResultSchema,
	mediaServerSchema,
	plexPinSchema,
	remoteLibraryChoiceSchema,
} from '@moirai/shared/api-contracts';
import { openMediaServerClient } from '../media-servers/client.js';
import { createMediaFetch, MediaServerRequestError, normalizeBaseUrl } from '../media-servers/http.js';
import { canRetainMediaServerCredential } from '../media-servers/credentials.js';
import { JellyfinClient } from '../media-servers/jellyfin-client.js';
import { assertAbsoluteLocalPrefixes } from '../media-servers/paths.js';
import { PlexClient } from '../media-servers/plex-client.js';
import { plexServerToken } from '../media-servers/plex-sign-in.js';
import type { MediaServerInspection, RemoteLibraryType } from '../media-servers/items.js';
import { MediaServerPersistenceError } from '../repository/media-servers.js';
import type { Repository } from '../repository/index.js';
import type { ScannerManager } from '../scanner/manager.js';
import { apiOperation, emptyResponseSchema, idParamsSchema, responseContent } from './contracts.js';

/** Services that save media servers and refresh libraries after a path mapping changes. */
interface MediaServerRouteDependencies {
	repository: Repository;
	scanner: ScannerManager;
}

/** Remote library types the picker can request. */
const remoteTypeSchema = z.enum(['movies', 'shows', 'music-videos', 'other']);

/** Register media-server connection, probe, and sign-in routes. Tokens are write-only. */
export function registerMediaServerRoutes(
	app: FastifyInstance,
	{ repository, scanner }: MediaServerRouteDependencies,
): void {
	app.get('/api/v1/media-servers', {
		schema: apiOperation({
			operationId: 'listMediaServers',
			tags: ['Media servers'],
			summary: 'List saved Plex, Jellyfin, and Emby servers',
			response: { 200: responseContent('Saved media servers', 'application/json', z.array(mediaServerSchema)) },
			errors: [500, 503],
		}),
	}, async () => repository.mediaServers.listMediaServers());

	app.post('/api/v1/media-servers', {
		schema: apiOperation({
			operationId: 'createMediaServer',
			tags: ['Media servers'],
			summary: 'Save a media server after confirming its identity',
			body: mediaServerCreateSchema,
			response: { 201: responseContent('Saved media server', 'application/json', mediaServerSchema) },
			errors: [400, 409, 500, 503],
		}),
	}, async (request, reply) => {
		const input = normalizeCreate(mediaServerCreateSchema.parse(request.body));
		const inspection = await inspect(input);
		const server = await save(() => repository.mediaServers.createMediaServer(input, inspection));
		return reply.status(201).send(server);
	});

	app.patch('/api/v1/media-servers/:id', {
		schema: apiOperation({
			operationId: 'updateMediaServer',
			tags: ['Media servers'],
			summary: 'Update a media server and rescan libraries when path mappings change',
			description: 'A retained credential cannot move to another destination or weaken certificate verification. Concurrent edits that violate this boundary return 409; reload the latest connection before retrying.',
			params: idParamsSchema,
			body: mediaServerUpdateSchema,
			response: { 200: responseContent('Updated media server', 'application/json', mediaServerSchema) },
			errors: [400, 404, 409, 500, 503],
		}),
	}, async (request) => {
		const { id } = idParamsSchema.parse(request.params);
		const input = mediaServerUpdateSchema.parse(request.body);
		const connection = await resolveConnection(id, input);
		assertPaths(connection.pathReplacements);
		const inspection = await inspect(connection);
		// Keep explicitly supplied credentials bound to the TLS policy that was just tested.
		const updated = await save(() => repository.mediaServers.updateMediaServer(id, {
			...input,
			baseUrl: connection.baseUrl,
			allowInsecureTls: connection.allowInsecureTls,
			accessToken: input.accessToken,
			pathReplacements: connection.pathReplacements,
		}, inspection));
		if (!updated) {
			throw app.httpErrors.notFound('Media server not found');
		}

		for (const libraryId of updated.rescanLibraryIds) {
			void scanner.scan(libraryId, 'manual').catch(() => undefined);
		}

		return updated.server;
	});

	app.delete('/api/v1/media-servers/:id', {
		schema: apiOperation({
			operationId: 'deleteMediaServer',
			tags: ['Media servers'],
			summary: 'Delete a media server that no library uses',
			params: idParamsSchema,
			response: { 204: responseContent('Media server deleted', 'application/json', emptyResponseSchema) },
			errors: [404, 409, 500, 503],
		}),
	}, async (request, reply) => {
		const { id } = idParamsSchema.parse(request.params);
		const removed = await save(() => repository.mediaServers.deleteMediaServer(id));
		if (!removed) {
			throw app.httpErrors.notFound('Media server not found');
		}

		return reply.status(204).send();
	});

	app.get('/api/v1/media-servers/:id/libraries', {
		schema: apiOperation({
			operationId: 'listMediaServerLibraries',
			tags: ['Media servers'],
			summary: 'List remote libraries of one Moirai type',
			params: idParamsSchema,
			querystring: z.object({ typeKey: remoteTypeSchema }),
			response: {
				200: responseContent('Remote libraries', 'application/json', z.array(remoteLibraryChoiceSchema)),
			},
			errors: [400, 404, 500, 503],
		}),
	}, async (request) => {
		const { id } = idParamsSchema.parse(request.params);
		const { typeKey } = z.object({ typeKey: remoteTypeSchema }).parse(request.query);
		const connection = await repository.mediaServers.getMediaServerConnection(id);
		if (!connection) {
			throw app.httpErrors.notFound('Media server not found');
		}

		const inspection = await inspect(connection);
		return choices(inspection, typeKey);
	});

	app.post('/api/v1/media-servers/probe', {
		schema: apiOperation({
			operationId: 'probeMediaServer',
			tags: ['Media servers'],
			summary: 'Test a media server and list libraries without saving it',
			body: mediaServerProbeSchema,
			response: { 200: responseContent('Media server probe', 'application/json', mediaServerProbeResultSchema) },
			errors: [400, 500, 503],
		}),
	}, async (request) => {
		const input = mediaServerProbeSchema.parse(request.body);
		const inspection = await inspect({
			...input,
			name: 'Probe',
			playbackReportingEnabled: false,
			baseUrl: normalizeAddress(input.baseUrl),
			pathReplacements: [],
			clientIdentifier: input.clientIdentifier ?? randomUUID(),
		});
		return {
			serverKey: inspection.serverKey,
			serverName: inspection.serverName,
			libraries: choices(inspection, input.typeKey as RemoteLibraryType),
		};
	});

	app.post('/api/v1/media-servers/:id/probe', {
		schema: apiOperation({
			operationId: 'probeSavedMediaServer',
			tags: ['Media servers'],
			summary: 'Test edited server connection settings without saving them',
			params: idParamsSchema,
			body: savedMediaServerProbeSchema,
			response: { 200: responseContent('Media server probe', 'application/json', mediaServerProbeResultSchema) },
			errors: [400, 404, 500, 503],
		}),
	}, async (request) => {
		const { id } = idParamsSchema.parse(request.params);
		const input = savedMediaServerProbeSchema.parse(request.body);
		const inspection = await inspect(await resolveConnection(id, input));
		return {
			serverKey: inspection.serverKey,
			serverName: inspection.serverName,
			libraries: choices(inspection, input.typeKey),
		};
	});

	app.post('/api/v1/media-servers/plex/pin', {
		schema: apiOperation({
			operationId: 'createPlexPin',
			tags: ['Media servers'],
			summary: 'Start a Plex link-code sign-in',
			body: z.object({ clientIdentifier: mediaServerClientIdentifierSchema.optional() }),
			response: { 201: responseContent('Plex sign-in code', 'application/json', plexPinSchema) },
			errors: [400, 500, 503],
		}),
	}, async (request, reply) => {
		const body = z.object({ clientIdentifier: mediaServerClientIdentifierSchema.optional() })
			.parse(request.body ?? {});
		const clientIdentifier = body.clientIdentifier ?? randomUUID();
		try {
			const pin = await PlexClient.createPin(createMediaFetch(false), clientIdentifier);
			return reply.status(201).send({ ...pin, clientIdentifier });
		}
		catch (error) {
			throw upstreamError(error);
		}
	});

	app.get('/api/v1/media-servers/plex/pin/:pinId', {
		schema: apiOperation({
			operationId: 'pollPlexPin',
			tags: ['Media servers'],
			summary: 'Resolve a Plex link code to the selected server credential',
			description: 'Requires the destination baseUrl. The Plex account token stays on the server; only a credential for a matching Plex-advertised server address is returned.',
			params: z.object({ pinId: z.coerce.number().int().positive() }),
			querystring: plexPinPollSchema,
			response: {
				200: responseContent('Plex credential', 'application/json', mediaServerCredentialResultSchema),
			},
			errors: [400, 500, 503],
		}),
	}, async (request) => {
		const { pinId } = z.object({ pinId: z.coerce.number().int().positive() }).parse(request.params);
		const { clientIdentifier, baseUrl } = plexPinPollSchema.parse(request.query);
		try {
			const fetch = createMediaFetch(false);
			const accountToken = await PlexClient.pollPin(fetch, clientIdentifier, pinId);
			const accessToken = accountToken ? await plexServerToken(fetch, clientIdentifier, accountToken, baseUrl) : null;
			return { accessToken, clientIdentifier };
		}
		catch (error) {
			throw upstreamError(error);
		}
	});

	app.post('/api/v1/media-servers/session', {
		schema: apiOperation({
			operationId: 'signInMediaServer',
			tags: ['Media servers'],
			summary: 'Exchange a Jellyfin or Emby password for an access token',
			description: 'The password is not stored.',
			body: mediaServerSignInSchema,
			response: { 200: responseContent('Media server credential', 'application/json', mediaServerCredentialResultSchema) },
			errors: [400, 500, 503],
		}),
	}, async (request) => {
		const input = mediaServerSignInSchema.parse(request.body);
		const clientIdentifier = input.clientIdentifier ?? randomUUID();
		const baseUrl = normalizeAddress(input.baseUrl);
		try {
			const accessToken = await JellyfinClient.signIn(
				createMediaFetch(input.allowInsecureTls),
				{ provider: input.provider, baseUrl, clientIdentifier },
				input.username,
				input.password,
			);
			return { accessToken, clientIdentifier };
		}
		catch (error) {
			throw upstreamError(error);
		}
	});

	/** Resolve a draft without exposing a retained credential to another destination or weaker TLS. */
	async function resolveConnection(id: string, input: MediaServerUpdate): Promise<MediaServerCreate> {
		const existing = await repository.mediaServers.getMediaServerConnection(id);
		if (!existing) {
			throw app.httpErrors.notFound('Media server not found');
		}
		if (input.provider && input.provider !== existing.provider) {
			throw app.httpErrors.badRequest('A saved server cannot change its provider');
		}

		const baseUrl = normalizeAddress(input.baseUrl ?? existing.baseUrl);
		const suppliedToken = input.accessToken?.trim();
		if (!suppliedToken && !canRetainMediaServerCredential(existing, { baseUrl, allowInsecureTls: input.allowInsecureTls })) {
			throw app.httpErrors.badRequest('Enter a credential before changing the server address or allowing an untrusted certificate');
		}

		return {
			provider: existing.provider,
			name: input.name ?? existing.name,
			baseUrl,
			accessToken: suppliedToken || existing.accessToken,
			allowInsecureTls: input.allowInsecureTls ?? existing.allowInsecureTls,
			playbackReportingEnabled: input.playbackReportingEnabled ?? existing.playbackReportingEnabled,
			pathReplacements: input.pathReplacements ?? existing.pathReplacements,
			clientIdentifier: input.clientIdentifier?.trim() || existing.clientIdentifier,
		};
	}

	/** Normalize an address and reject a local folder that playback could not open. */
	function normalizeCreate(input: MediaServerCreate): MediaServerCreate {
		const next = { ...input, baseUrl: normalizeAddress(input.baseUrl) };
		assertPaths(next.pathReplacements);
		return next;
	}

	/** Confirm the server and keep the credential out of the failure text. */
	async function inspect(input: MediaServerCreate): Promise<MediaServerInspection> {
		try {
			const client = openMediaServerClient(createMediaFetch(input.allowInsecureTls), {
				provider: input.provider,
				baseUrl: input.baseUrl,
				accessToken: input.accessToken,
				clientIdentifier: input.clientIdentifier ?? randomUUID(),
				allowInsecureTls: input.allowInsecureTls,
			});
			return await client.inspect();
		}
		catch (error) {
			throw upstreamError(error);
		}
	}

	/** Map persistence failures onto the documented HTTP statuses. */
	async function save<T>(operation: () => Promise<T>): Promise<T> {
		try {
			return await operation();
		}
		catch (error) {
			if (error instanceof MediaServerPersistenceError) {
				throw error.statusCode === 400
					? app.httpErrors.badRequest(error.message)
					: app.httpErrors.conflict(error.message);
			}

			throw error;
		}
	}
}

/** Require a usable http(s) address. */
function normalizeAddress(value: string): string {
	try {
		return normalizeBaseUrl(value);
	}
	catch (error) {
		if (error instanceof MediaServerRequestError) {
			throw Object.assign(new Error(error.message), { statusCode: 400, expose: true });
		}

		throw error;
	}
}

/** Reject path mappings playback could not treat as local files. */
function assertPaths(replacements: MediaServerCreate['pathReplacements']): void {
	try {
		assertAbsoluteLocalPrefixes(replacements);
	}
	catch (error) {
		throw Object.assign(
			new Error(error instanceof Error ? error.message : 'Local playback folder must be an absolute path'),
			{ statusCode: 400, expose: true },
		);
	}
}

/** Keep provider bodies and tokens out of the response shown to the operator. */
function upstreamError(error: unknown): Error {
	if (error instanceof MediaServerRequestError) {
		return Object.assign(new Error(error.message), { statusCode: 400, expose: true });
	}

	return new Error('Media server request failed');
}

/** Keep remote libraries that match the Moirai library the operator is editing. */
function choices(inspection: MediaServerInspection, typeKey: RemoteLibraryType) {
	return inspection.libraries
		.filter((library) => library.typeKey === typeKey)
		.map((library) => ({ id: library.id, name: library.name, typeKey: library.typeKey }));
}
