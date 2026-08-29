import { describe, expect, it } from 'vitest';
import { suppressRoutineRequestLog } from '@server/routes/request-logging.js';

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
});
