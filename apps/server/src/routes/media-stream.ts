import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { openMediaServerClient } from '../media-servers/client.js';
import { createMediaFetch, type MediaFetch } from '../media-servers/http.js';
import { verifyMediaStream } from '../media-servers/stream-url.js';
import type { Repository } from '../repository/index.js';
import { apiOperation, binaryBodySchema, responseContent } from './contracts.js';

/** Loopback publisher that can resolve a signed part without a browser session. */
interface MediaStreamRouteDependencies {
	repository: Repository;
	secret: string;
	fetchFor?: (allowInsecureTls: boolean) => MediaFetch;
}

/** Query that identifies one signed provider part. */
const mediaStreamQuerySchema = z.object({
	server: z.uuid(),
	part: z.string().min(1).max(500),
	exp: z.coerce.number().int(),
	sig: z.string().min(1).max(200),
});

/** Require a loopback peer even when a route fixture supplies a forged remote address. */
function localWorkerPeer(address: string | undefined): boolean {
	return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

/**
 * Proxy one provider file to the local channel worker.
 * The route checks the TCP peer and the signature, then forwards Range without putting the
 * provider credential in the URL.
 */
export function registerMediaStreamRoutes(
	app: FastifyInstance,
	{ repository, secret, fetchFor = createMediaFetch }: MediaStreamRouteDependencies,
): void {
	app.get('/api/v1/internal/media', {
		config: { authentication: 'public' },
		schema: apiOperation({
			operationId: 'streamMediaServerPart',
			tags: ['Playback'],
			summary: 'Stream one signed media-server part to the local channel worker',
			authentication: 'public',
			querystring: mediaStreamQuerySchema,
			response: {
				200: responseContent('Media bytes', 'application/octet-stream', binaryBodySchema),
				206: responseContent('Partial media bytes', 'application/octet-stream', binaryBodySchema),
			},
			errors: [403, 404, 502],
		}),
	}, async (request, reply) => {
		if (!localWorkerPeer(request.socket.remoteAddress)) {
			throw app.httpErrors.forbidden('Media streaming is only available to the local playback worker');
		}

		const query = mediaStreamQuerySchema.parse(request.query);
		if (!verifyMediaStream(secret, query.exp, query.server, query.part, query.sig)) {
			throw app.httpErrors.forbidden('Media stream signature is not valid');
		}

		const connection = await repository.mediaServers.getMediaServerConnection(query.server);
		if (!connection) {
			throw app.httpErrors.notFound('Media server not found');
		}

		const fetch = fetchFor(connection.allowInsecureTls);
		const client = openMediaServerClient(fetch, connection);
		let upstreamRequest;
		try {
			upstreamRequest = client.streamRequest(query.part);
		}
		catch {
			throw app.httpErrors.badGateway('Media server connection is invalid');
		}
		const abort = new AbortController();
		request.raw.on('aborted', () => abort.abort());
		reply.raw.on('close', () => abort.abort());
		const headers: Record<string, string> = {
			...upstreamRequest.headers,
			'User-Agent': 'Moirai',
		};
		const range = request.headers.range;
		if (typeof range === 'string' && range) {
			headers.Range = range;
		}

		let upstream;
		try {
			upstream = await fetch(upstreamRequest.url, {
				headers,
				signal: abort.signal,
				streaming: true,
			});
		}
		catch {
			throw app.httpErrors.badGateway('Media server could not be reached');
		}

		if (upstream.status !== 200 && upstream.status !== 206) {
			await upstream.body?.cancel();
			const message = upstream.status === 401 || upstream.status === 403
				? 'Media server rejected the credential'
				: `Media server returned HTTP ${upstream.status}`;
			throw app.httpErrors.badGateway(message);
		}

		reply.status(upstream.status);
		reply.header('Cache-Control', 'private, no-store');
		reply.type('application/octet-stream');
		reply.header('X-Content-Type-Options', 'nosniff');

		for (const name of ['content-length', 'content-range', 'accept-ranges']) {
			const value = upstream.headers.get(name);
			if (value) {
				reply.header(name, value);
			}
		}

		if (!upstream.body) {
			return reply.send();
		}

		return reply.send(Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]));
	});
}
