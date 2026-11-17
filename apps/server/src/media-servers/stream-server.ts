import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import { validatorCompiler } from 'fastify-type-provider-zod';
import type { Repository } from '../repository/index.js';
import { registerMediaStreamRoutes } from '../routes/media-stream.js';
import { responseSerializerCompiler } from '../routes/contracts.js';
import { publicError } from '../routes/public-errors.js';

/**
 * Own the private loopback listener used exclusively by playback workers.
 * It starts before playout publication and closes after workers stop; it never logs bearer URLs.
 */
export class MediaStreamServer {
	private readonly app: FastifyInstance;

	constructor(repository: Repository, secret: string) {
		this.app = Fastify({ logger: false });
		this.app.setValidatorCompiler(validatorCompiler);
		this.app.setSerializerCompiler(responseSerializerCompiler);
		this.app.register(sensible);
		this.app.setErrorHandler((error, request, reply) => {
			const mapped = publicError(error, request.id);
			reply.status(mapped.statusCode).send(mapped.body);
		});
		this.app.register(async (app) => {
			registerMediaStreamRoutes(app, { repository, secret });
		});
	}

	/** Bind an OS-assigned loopback port and return the address published into worker documents. */
	async start(): Promise<string> {
		return this.app.listen({ host: '127.0.0.1', port: 0 });
	}

	/** Close the private listener after its playback consumers have stopped. */
	async close(): Promise<void> {
		await this.app.close();
	}
}
