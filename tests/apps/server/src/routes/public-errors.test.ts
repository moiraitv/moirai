import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { publicError } from '@server/routes/public-errors.js';

const REQUEST_ID = 'request-17';

describe('public error policy', () => {
	it('does not expose unexpected internal messages', () => {
		const mapped = publicError(
			new Error('SQLITE_ERROR near /Volumes/Private/Movies: secret detail'),
			REQUEST_ID,
		);
		expect(mapped).toMatchObject({
			statusCode: 500,
			body: {
				code: 'internal_error',
				message: 'An unexpected server error occurred',
				requestId: REQUEST_ID,
			},
			expected: false,
		});
		expect(JSON.stringify(mapped.body)).not.toContain('/Volumes/Private');
	});

	it('maps storage failures without returning their paths', () => {
		const error = Object.assign(new Error('EACCES: /private/catalog.sqlite'), { code: 'EACCES' });
		const mapped = publicError(error, REQUEST_ID);
		expect(mapped.statusCode).toBe(503);
		expect(mapped.body.code).toBe('storage_unavailable');
		expect(mapped.body.message).not.toContain('/private');
	});

	it('preserves expected service-unavailable status without exposing details', () => {
		const error = Object.assign(new Error('Artwork failed at /Volumes/Private/poster.jpg'), {
			statusCode: 503,
		});
		const mapped = publicError(error, REQUEST_ID);
		expect(mapped).toMatchObject({
			statusCode: 503,
			retryAfter: '5',
			body: { code: 'service_unavailable', requestId: REQUEST_ID },
			expected: true,
		});
		expect(JSON.stringify(mapped.body)).not.toContain('/Volumes/Private');
	});

	it('returns bounded validation issues without input values', () => {
		const parsed = z.object({ count: z.number().int().positive() }).safeParse({ count: -4 });
		expect(parsed.success).toBe(false);
		if (parsed.success) {
			return;
		}

		const mapped = publicError(parsed.error, REQUEST_ID);
		expect(mapped.statusCode).toBe(400);
		expect(mapped.body.details).toEqual([
			expect.objectContaining({ path: ['count'], code: 'too_small' }),
		]);
	});
});
