import { BackupContentError, BackupValidationError, validationFailure } from '@server/backup/errors.js';
import { BACKUP_VALIDATION_MESSAGES, type BackupValidationCode } from '@moirai/shared';
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

	it.each([
		['EACCES', 'Permission denied'], ['EPERM', 'Permission denied'], ['EROFS', 'read-only'],
		['ENOSPC', 'full'], ['ENOTDIR', 'not a directory'], ['ENOENT', 'missing'],
		['EIO', 'read or write failed'], ['SQLITE_FULL', 'full'], ['SQLITE_READONLY', 'read-only'],
	])('explains %s storage failures without exposing raw paths', (code, expected) => {
		const error = Object.assign(new Error(`${code}: sensitive detail /private/backup.zip`), { code });
		const mapped = publicError(error, REQUEST_ID);
		expect(mapped.statusCode).toBe(503);
		expect(mapped.body.code).toBe('storage_unavailable');
		expect(mapped.body.message).toContain(expected);
		expect(mapped.body.message).not.toContain('sensitive detail');
		expect(mapped.body.message).not.toContain('/private');
	});

	it('maps a missing SQLite migration to an actionable restart message', () => {
		const error = Object.assign(
			new Error('no such column: "early_start_max_drift_seconds"'),
			{ code: 'SQLITE_ERROR' },
		);
		const mapped = publicError(error, REQUEST_ID);

		expect(mapped).toMatchObject({
			statusCode: 503,
			body: {
				code: 'database_upgrade_required',
				message: 'The database schema is out of date. Restart the server to apply pending migrations.',
				requestId: REQUEST_ID,
			},
			expected: true,
		});
		expect(JSON.stringify(mapped.body)).not.toContain('early_start_max_drift_seconds');
	});

	it('keeps an application-authored unavailable message without a short retry', () => {
		const mapped = publicError(Object.assign(new Error('AI is not configured.'), {
			statusCode: 503,
			expose: true,
		}), REQUEST_ID);
		expect(mapped).toMatchObject({
			statusCode: 503,
			body: { code: 'service_unavailable', message: 'AI is not configured.', requestId: REQUEST_ID },
			expected: true,
		});
		expect(mapped.retryAfter).toBeUndefined();
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

	it('preserves Fastify request-body limits as a safe client error', () => {
		const error = Object.assign(new Error('Request body is too large'), {
			statusCode: 413,
			code: 'FST_ERR_CTP_BODY_TOO_LARGE',
		});
		expect(publicError(error, REQUEST_ID)).toMatchObject({
			statusCode: 413,
			body: { code: 'payload_too_large', requestId: REQUEST_ID },
			expected: true,
		});
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


it.each(Object.keys(BACKUP_VALIDATION_MESSAGES) as BackupValidationCode[])('returns a safe %s failure with its request ID', code => {
	const error = new BackupValidationError(code, { name: 'Error', reason: 'private diagnostic' });
	const mapped = publicError(error, REQUEST_ID);
	expect(mapped.statusCode).toBe(422);
	expect(mapped.body).toMatchObject({ code, message: BACKUP_VALIDATION_MESSAGES[code], requestId: REQUEST_ID });
	expect(JSON.stringify(mapped.body)).not.toContain('private diagnostic');
});


it('logs application-authored validation reasons while withholding raw parser input', () => {
	const expected = validationFailure('backup_invalid_archive', new BackupContentError('Backup content checksum mismatch')) as BackupValidationError;
	expect(expected.diagnostic?.reason).toBe('Backup content checksum mismatch');
	const parser = validationFailure('backup_invalid_records', new SyntaxError('PRIVATE_CONFIGURATION_VALUE')) as BackupValidationError;
	expect(parser.diagnostic?.reason).toBe('invalid_json');
	expect(JSON.stringify(parser)).not.toContain('PRIVATE_CONFIGURATION_VALUE');
});
