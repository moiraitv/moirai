import Fastify from 'fastify';
import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { RoutineRequestLogController, suppressRoutineRequestLog } from '@server/routes/request-logging.js';

describe('automatic request logging', () => {
	it('suppresses the routine log-page reads including query variants', () => {
		expect(suppressRoutineRequestLog('GET', '/api/v1/logs?limit=100')).toBe(true);
		expect(suppressRoutineRequestLog('get', '/api/v1/logs/files')).toBe(true);
		expect(
			suppressRoutineRequestLog(
				'GET',
				'/api/v1/auth/logto/callback?code=temporary-code&state=temporary-state',
			),
		).toBe(true);
	});

	it('retains mutations, downloads, and unrelated API access records', () => {
		expect(suppressRoutineRequestLog('POST', '/api/v1/logs')).toBe(false);
		expect(
			suppressRoutineRequestLog('GET', '/api/v1/logs/files/moirai-2026-08-25.jsonl'),
		).toBe(false);
		expect(suppressRoutineRequestLog('GET', '/api/v1/channels')).toBe(false);
	});

	it('omits successful routine polls while logging failures, generation mutations, and unrelated requests', async () => {
		const entries: Array<{ msg: string; res?: { statusCode: number } }> = [];
		const stream = new Writable({ write(chunk, _encoding, callback) {
			entries.push(JSON.parse(String(chunk)));
			callback();
		} });
		const app = Fastify({ logger: { level: 'info', stream }, logController: new RoutineRequestLogController() });
		app.get('/api/v1/health/ready', async (request, reply) => {
			const query = request.query as { fail?: string };
			return reply.code(query.fail ? 503 : 200).send({ status: query.fail ? 'degraded' : 'ready' });
		});
		app.get('/api/v1/health/live', async () => ({ status: 'ok' }));
		app.get('/api/v1/playback/status', async (request, reply) => {
			const query = request.query as { fail?: string };
			return reply.code(query.fail ? 503 : 200).send({ ready: !query.fail });
		});
		app.get('/api/v1/ai/generations/:id', async (request, reply) => {
			const query = request.query as { fail?: string };
			return reply.code(query.fail ? 404 : 200).send({ state: 'running' });
		});
		app.post('/api/v1/ai/generations', async () => ({ state: 'running' }));
		app.delete('/api/v1/ai/generations/:id', async () => ({ state: 'cancelled' }));
		app.get('/api/v1/channels', async () => []);
		try {
			expect((await app.inject('/api/v1/health/ready?probe=1')).statusCode).toBe(200);
			expect((await app.inject('/api/v1/playback/status?poll=1')).statusCode).toBe(200);
			expect((await app.inject('/api/v1/ai/generations/run-id?poll=1')).statusCode).toBe(200);
			expect(entries).toEqual([]);

			expect((await app.inject('/api/v1/health/ready?fail=1')).statusCode).toBe(503);
			expect(entries.some(entry => entry.msg === 'request completed' && entry.res?.statusCode === 503)).toBe(true);
			const beforePlaybackFailure = entries.length;
			expect((await app.inject('/api/v1/playback/status?fail=1')).statusCode).toBe(503);
			expect(entries.slice(beforePlaybackFailure).some(entry => entry.msg === 'request completed' && entry.res?.statusCode === 503)).toBe(true);
			const beforeAiFailure = entries.length;
			expect((await app.inject('/api/v1/ai/generations/run-id?fail=1')).statusCode).toBe(404);
			expect(entries.slice(beforeAiFailure).some(entry => entry.msg === 'request completed' && entry.res?.statusCode === 404)).toBe(true);

			const beforeMutation = entries.length;
			expect((await app.inject({ method: 'POST', url: '/api/v1/ai/generations' })).statusCode).toBe(200);
			expect((await app.inject({ method: 'DELETE', url: '/api/v1/ai/generations/run-id' })).statusCode).toBe(200);
			expect(entries.slice(beforeMutation).filter(entry => entry.msg === 'incoming request')).toHaveLength(2);

			const beforeOtherRead = entries.length;
			expect((await app.inject('/api/v1/health/live')).statusCode).toBe(200);
			expect(entries.slice(beforeOtherRead).some(entry => entry.msg === 'incoming request')).toBe(true);
			expect((await app.inject('/api/v1/channels')).statusCode).toBe(200);
			expect(entries.at(-2)?.msg).toBe('incoming request');
		}
		finally {
			await app.close();
		}
	});
});
