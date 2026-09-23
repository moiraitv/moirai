import type { FastifyReply } from 'fastify';

/** Cancel an abandoned worker read when its HTTP consumer disconnects. */
export function workerRequestSignal(reply: FastifyReply): AbortSignal {
	const controller = new AbortController();
	const abort = (): void => controller.abort();
	reply.raw.once('close', abort);
	reply.raw.once('finish', () => reply.raw.removeListener('close', abort));
	return controller.signal;
}

/** Send JSON already validated and serialized by a trusted worker without repeating that work. */
export function sendWorkerJson(reply: FastifyReply, body: string): FastifyReply {
	return reply.type('application/json; charset=utf-8').send(Buffer.from(body));
}
