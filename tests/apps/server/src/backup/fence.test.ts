import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { expect, it } from 'vitest';
import { BackupFence } from '@server/backup/fence.js';

it('drains admitted mutations, rejects new writes, and keeps delivery reads available during capture', async () => {
	const app = Fastify();
	await app.register(sensible);
	const fence = new BackupFence();
	fence.register(app);
	let release!: () => void;
	let started!: () => void;
	const gate = new Promise<void>(resolve => {
		release = resolve; 
	});
	const admission = new Promise<void>(resolve => {
		started = resolve; 
	});
	app.post('/write', async () => {
		started();
		await gate;
		return {};
	});
	app.get('/segment.ts', async () => Buffer.from('delivered media'));
	await app.ready();
	const writing = app.inject({ method: 'POST', url: '/write' }).then(response => response);
	try {
		await admission;
		let captured = false;
		const capturing = fence.capture().then(unlock => {
			captured = true;
			return unlock; 
		});
		expect((await app.inject({ method: 'POST', url: '/write' })).statusCode).toBe(503);
		expect((await app.inject('/segment.ts')).body).toBe('delivered media');
		expect(captured).toBe(false);
		release();
		await writing;
		(await capturing)();
		expect(captured).toBe(true);
	}
	finally {
		release();
		await writing;
		await app.close();
	}
});

it('matches encoded backup routes by their registered template and rejects delivery during maintenance', async () => {
	const app = Fastify();
	await app.register(sensible);
	const fence = new BackupFence();
	fence.register(app);
	app.post('/api/v1/backups', async () => {
		const release = await fence.capture();
		release();
		return {};
	});
	app.get('/segment.ts', async () => Buffer.from('media'));
	app.get('/api/v1/health/live', async () => ({ status: 'ok' }));
	try {
		expect((await app.inject({ method: 'POST', url: '/api/v1/%62ackups' })).statusCode).toBe(200);
		fence.enterMaintenance();
		expect((await app.inject('/segment.ts')).statusCode).toBe(503);
		expect((await app.inject('/api/v1/health/live')).statusCode).toBe(200);
		fence.leaveMaintenance();
		expect((await app.inject('/segment.ts')).statusCode).toBe(200);
	}
	finally {
		await app.close();
	}
});
