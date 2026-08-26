import { describe, expect, it } from 'vitest';
import type { LogEntry } from '@moirai/shared';
import { condenseRequestLogs, logRequestDetails } from '@web/log-entry-context';

describe('log request context', () => {
	it('extracts Fastify request fields without exposing query values', () => {
		expect(
			logRequestDetails({
				req: {
					method: 'get',
					url: '/api/v1/libraries?token=secret',
					remoteAddress: '127.0.0.1',
				},
			}),
		).toEqual({
			method: 'GET',
			endpoint: '/api/v1/libraries',
			sourceIp: '127.0.0.1',
		});
	});

	it('supports direct application request fields and absolute URLs', () => {
		expect(
			logRequestDetails({
				method: 'post',
				url: 'https://moirai.example.test/api/v1/channels#detail',
				ip: '2001:db8::1',
			}),
		).toEqual({
			method: 'POST',
			endpoint: '/api/v1/channels',
			sourceIp: '2001:db8::1',
		});
	});

	it('returns empty request fields for unrelated structured context', () => {
		expect(logRequestDetails({ libraryId: 'library-one' })).toEqual({
			method: null,
			endpoint: null,
			sourceIp: null,
		});
	});
});

describe('request log condensation', () => {
	it('merges a completed request into its incoming record and keeps intervening application logs', () => {
		const incoming: LogEntry = {
			id: 'incoming',
			time: '2026-08-25T10:00:00.000Z',
			level: 'info',
			message: 'incoming request',
			requestId: 'req-1',
			context: { req: { method: 'GET', url: '/api/v1/libraries' } },
		};
		const application: LogEntry = {
			id: 'application',
			time: '2026-08-25T10:00:00.010Z',
			level: 'debug',
			message: 'Read catalog',
			requestId: 'req-1',
			context: { count: 4 },
		};
		const completed: LogEntry = {
			id: 'completed',
			time: '2026-08-25T10:00:00.025Z',
			level: 'info',
			message: 'request completed',
			requestId: 'req-1',
			context: { res: { statusCode: 200 }, responseTime: 24.75 },
		};

		const condensed = condenseRequestLogs([completed, application, incoming]);
		expect(condensed.map((record) => record.entry.id)).toEqual(['incoming', 'application']);
		expect(condensed[0]?.completion).toMatchObject({
			durationMs: 24.75,
			statusCode: 200,
		});
	});

	it('retains unmatched lifecycle records and derives elapsed time when needed', () => {
		const incoming: LogEntry = {
			id: 'incoming',
			time: '2026-08-25T10:00:00.000Z',
			level: 'info',
			message: 'incoming request',
			requestId: 'req-2',
			context: { req: { method: 'POST', url: '/api/v1/channels' } },
		};
		const completed: LogEntry = {
			id: 'completed',
			time: '2026-08-25T10:00:00.040Z',
			level: 'info',
			message: 'request completed',
			requestId: 'req-2',
			context: { res: { statusCode: 204 } },
		};
		expect(condenseRequestLogs([incoming])).toEqual([{ entry: incoming, completion: null }]);
		expect(condenseRequestLogs([completed])).toEqual([
			{
				entry: completed,
				completion: { entry: completed, durationMs: null, statusCode: 204 },
			},
		]);
		expect(condenseRequestLogs([completed, incoming])[0]?.completion?.durationMs).toBe(40);
	});

	it('does not cross-pair reused request IDs from different server lifetimes', () => {
		const incoming = (id: string, time: string): LogEntry => ({
			id,
			time,
			level: 'info',
			message: 'incoming request',
			requestId: 'req-1',
			context: { req: { method: 'GET', url: '/api/v1/status' } },
		});
		const completed = (id: string, time: string, responseTime: number): LogEntry => ({
			id,
			time,
			level: 'info',
			message: 'request completed',
			requestId: 'req-1',
			context: { responseTime, res: { statusCode: 200 } },
		});
		const currentIncoming = incoming('current-incoming', '2026-08-25T10:10:00.000Z');
		const currentCompleted = completed('current-completed', '2026-08-25T10:10:00.020Z', 20);
		const oldIncoming = incoming('old-incoming', '2026-08-25T09:00:00.000Z');
		const oldCompleted = completed('old-completed', '2026-08-25T09:00:00.050Z', 50);

		const condensed = condenseRequestLogs([
			currentCompleted,
			currentIncoming,
			oldCompleted,
			oldIncoming,
		]);
		expect(condensed.map((record) => record.entry.id)).toEqual([
			'current-incoming',
			'old-incoming',
		]);
		expect(condensed.map((record) => record.completion?.durationMs)).toEqual([20, 50]);
	});
});
