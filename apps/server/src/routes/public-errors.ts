import { ZodError } from 'zod';
import { hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod';
import type { ApiErrorBody } from '@moirai/shared';
import { MediaPreviewError } from '../media/media-preview.js';
import { PlaybackCapacityError, PlaybackUnavailableError } from '../playback/playback-engine.js';
import { TimelineMaterializationLimitError } from '../scheduling/engine.js';
import { SchedulingQueueFullError } from '../scheduling/worker-pool.js';
import { SchedulingValidationError } from '../scheduling/validation.js';
import {
	ResourceIdentityConflictError,
	SchedulingIdentityConflictError,
} from '../repository/resource-identity.js';

/** Expected application error that may safely expose a client status. */
interface ErrorWithStatus extends Error {
	statusCode?: number;
	expose?: boolean;
	code?: string;
}

/** Sanitized HTTP error body and status returned to a client. */
export interface PublicError {
	statusCode: number;
	body: ApiErrorBody;
	retryAfter?: string;
	expected: boolean;
}

/** SQLite constraint codes that map safely to a public conflict response. */
const SQLITE_CONFLICT_CODES = new Set([
	'SQLITE_CONSTRAINT',
	'SQLITE_CONSTRAINT_FOREIGNKEY',
	'SQLITE_CONSTRAINT_PRIMARYKEY',
	'SQLITE_CONSTRAINT_UNIQUE',
]);
/** Filesystem and SQLite failures that map safely to temporary storage errors. */
const STORAGE_CODES = new Set([
	'EACCES',
	'EIO',
	'ENOENT',
	'ENOSPC',
	'ENOTDIR',
	'EPERM',
	'EROFS',
	'SQLITE_BUSY',
	'SQLITE_CANTOPEN',
	'SQLITE_FULL',
	'SQLITE_IOERR',
	'SQLITE_READONLY',
]);

/** Build the stable public error envelope returned by the API. */
function response(
	requestId: string,
	statusCode: number,
	code: string,
	message: string,
	expected: boolean,
	details?: unknown,
	retryAfter?: string,
): PublicError {
	return {
		statusCode,
		body: { code, message, requestId, ...(details === undefined ? {} : { details }) },
		expected,
		...(retryAfter === undefined ? {} : { retryAfter }),
	};
}

/** Convert internal failures into a stable response without exposing implementation details. */
export function publicError(error: unknown, requestId: string): PublicError {
	// Map expected validation and domain failures to their explicit public contracts.
	if (hasZodFastifySchemaValidationErrors(error)) {
		return response(
			requestId,
			400,
			'validation_error',
			'Request validation failed',
			true,
			error.validation.map((issue) => ({
				path: issue.instancePath
					.split('/')
					.filter(Boolean)
					.map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~')),
				code: issue.keyword,
				message: issue.message?.slice(0, 512) ?? 'Invalid value',
			})),
		);
	}

	if (error instanceof ZodError) {
		return response(
			requestId,
			400,
			'validation_error',
			'Request validation failed',
			true,
			error.issues.map((issue) => ({
				path: issue.path.map(String),
				code: issue.code,
				message: issue.message.slice(0, 512),
			})),
		);
	}

	if (error instanceof SchedulingValidationError) {
		return response(requestId, 400, 'validation_error', error.message, true);
	}

	if (error instanceof ResourceIdentityConflictError) {
		return response(requestId, 409, 'conflict', error.message, true);
	}

	if (error instanceof SchedulingIdentityConflictError) {
		return response(requestId, 409, 'conflict', error.message, true);
	}

	if (error instanceof SchedulingQueueFullError) {
		return response(
			requestId,
			503,
			'service_unavailable',
			'Scheduling is busy; retry shortly',
			true,
			undefined,
			'1',
		);
	}

	if (error instanceof MediaPreviewError) {
		return response(requestId, error.statusCode, 'request_failed', error.message, true);
	}

	if (error instanceof PlaybackCapacityError) {
		return response(requestId, 503, 'playback_capacity', error.message, true, undefined, '5');
	}

	if (error instanceof PlaybackUnavailableError) {
		return response(requestId, 503, 'playback_unavailable', error.message, true, undefined, '5');
	}

	if (error instanceof TimelineMaterializationLimitError) {
		return response(requestId, 422, 'request_failed', error.message, true);
	}

	// Map low-level storage and service failures without exposing their raw messages.
	const normalized = (error instanceof Error ? error : new Error(String(error))) as ErrorWithStatus;
	if (normalized.code && SQLITE_CONFLICT_CODES.has(normalized.code)) {
		return response(
			requestId,
			409,
			'conflict',
			'The requested change conflicts with existing data',
			true,
		);
	}

	if (normalized.code && STORAGE_CODES.has(normalized.code)) {
		return response(
			requestId,
			503,
			'storage_unavailable',
			'Required storage is temporarily unavailable',
			true,
			undefined,
			'5',
		);
	}

	if (normalized.statusCode === 503) {
		return response(
			requestId,
			503,
			'service_unavailable',
			'The requested service is temporarily unavailable',
			true,
			undefined,
			'5',
		);
	}

	if (normalized.statusCode === 413 && normalized.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
		return response(
			requestId,
			413,
			'payload_too_large',
			'Request body exceeds the permitted size',
			true,
		);
	}

	// Preserve safe framework-authored client errors and hide every unexpected failure.
	if (
		normalized.expose === true
		&& typeof normalized.statusCode === 'number'
		&& normalized.statusCode >= 400
		&& normalized.statusCode < 500
	) {
		const publicCode = normalized.code?.match(/^[a-z][a-z0-9_]{1,63}$/u)
			? normalized.code
			: normalized.statusCode === 404 ? 'not_found' : 'request_failed';
		return response(
			requestId,
			normalized.statusCode,
			publicCode,
			normalized.message,
			true,
			undefined,
			normalized.statusCode === 429 ? '900' : undefined,
		);
	}

	return response(
		requestId,
		500,
		'internal_error',
		'An unexpected server error occurred',
		false,
	);
}
