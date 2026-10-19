import { once } from 'node:events';
import { request as httpRequest, type ServerResponse } from 'node:http';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { validatorCompiler } from 'fastify-type-provider-zod';
import { expect, it, vi } from 'vitest';
import type { BackupService } from '@server/backup/service.js';
import { registerBackupRoutes } from '@server/routes/backups.js';
import { responseSerializerCompiler } from '@server/routes/contracts.js';

const restorePath = '/api/v1/backups/reviews/11111111-1111-4111-8111-111111111111/restore';

async function restoreApp(restore: () => Promise<void>) {
	const app = Fastify();
	await app.register(sensible);
	app.setValidatorCompiler(validatorCompiler);
	app.setSerializerCompiler(responseSerializerCompiler);
	const restart = vi.fn(async () => {});
	registerBackupRoutes(app, { backups: { restore } as unknown as BackupService, restartAfterRestore: restart });
	return { app, restart };
}

it.each([false, true])('restarts after disconnected preparation only when it succeeds (failure: %s)', async fail => {
	let admit!: () => void;
	let release!: () => void;
	const admitted = new Promise<void>(resolve => {
		admit = resolve;
	});
	const gate = new Promise<void>(resolve => {
		release = resolve;
	});
	const { app, restart } = await restoreApp(async () => {
		admit();
		await gate;
		if (fail) {
			throw new Error('Recovery backup failed');
		}
	});
	let response!: ServerResponse;
	app.addHook('onRequest', async (_request, reply) => {
		response = reply.raw;
	});
	// A real socket is required: injected requests do not reproduce a destroyed response.
	const address = await app.listen({ host: '127.0.0.1', port: 0 });
	const client = httpRequest(`${address}${restorePath}`, { method: 'POST' });
	client.on('error', () => {});
	client.end();
	try {
		await admitted;
		const closed = once(response, 'close');
		client.destroy();
		await closed;
		expect(restart).not.toHaveBeenCalled();
		release();
		// Closing drains the handler, including its failure path, before the restart turn runs.
		await app.close();
		await new Promise<void>(resolve => setImmediate(resolve));
		expect(restart).toHaveBeenCalledTimes(fail ? 0 : 1);
	}
	finally {
		release();
		client.destroy();
		await app.close();
	}
});

it('restarts once when the response disconnects after successful preparation', async () => {
	const { app, restart } = await restoreApp(async () => {});
	let sending!: () => void;
	let release!: () => void;
	const ready = new Promise<void>(resolve => {
		sending = resolve;
	});
	const gate = new Promise<void>(resolve => {
		release = resolve;
	});
	let response!: ServerResponse;
	app.addHook('onSend', async (_request, reply, payload) => {
		response = reply.raw;
		sending();
		await gate;
		return payload;
	});
	const address = await app.listen({ host: '127.0.0.1', port: 0 });
	const client = httpRequest(`${address}${restorePath}`, { method: 'POST' });
	client.on('error', () => {});
	client.end();
	try {
		await ready;
		const closed = once(response, 'close');
		client.destroy();
		await closed;
		await vi.waitFor(() => expect(restart).toHaveBeenCalledTimes(1));
		release();
		await app.close();
		await new Promise<void>(resolve => setImmediate(resolve));
		expect(restart).toHaveBeenCalledTimes(1);
	}
	finally {
		release();
		client.destroy();
		await app.close();
	}
});

it('delivers acceptance before restarting once for a normally completed response', async () => {
	const { app, restart } = await restoreApp(async () => {});
	let restartedAtFinish = -1;
	let closed = false;
	app.addHook('onRequest', async (_request, reply) => {
		reply.raw.once('finish', () => {
			restartedAtFinish = restart.mock.calls.length;
		});
		reply.raw.once('close', () => {
			closed = true;
		});
	});
	const address = await app.listen({ host: '127.0.0.1', port: 0 });
	try {
		const response = await fetch(`${address}${restorePath}`, { method: 'POST' });
		await response.text();
		expect(response.status).toBe(202);
		expect(restartedAtFinish).toBe(0);
		expect(closed).toBe(true);
		await vi.waitFor(() => expect(restart).toHaveBeenCalledTimes(1));
	}
	finally {
		await app.close();
	}
});
