import { BACKUP_VALIDATION_MESSAGES, type BackupValidationCode } from '@moirai/shared';
import { storageFailureMessage } from '../operations/storage-errors.js';

/** Expected administrative conflict or validation failure with a safe, operator-facing message. */
export class BackupOperationError extends Error {
	readonly expose = true;
	constructor(message: string, readonly statusCode: 404 | 409 | 422) {
		super(message);
	}
}

/** Application-authored validation reasons for server logs; never construct with archive values. */
export class BackupContentError extends Error {}

/** Bounded metadata explains a validation failure without recording input values or raw messages. */
export interface BackupValidationDiagnostic {
	name: string;
	code?: string;
	reason?: string;
	issues?: Array<{ code: string; path: string[] }>;
}
/** A failed validation stage carries a safe public explanation and sanitized server diagnostics. */
export class BackupValidationError extends BackupOperationError {
	constructor(readonly code: BackupValidationCode, readonly diagnostic?: BackupValidationDiagnostic) {
		super(BACKUP_VALIDATION_MESSAGES[code], 422);
	}
}

/** Keep storage causes intact and classify other failures without exposing untrusted error text. */
export function validationFailure(code: BackupValidationCode, cause: unknown): Error {
	if (cause instanceof BackupValidationError || storageFailureMessage(cause)) {
		return cause as Error;
	}
	const error = cause as { name?: unknown; code?: unknown; issues?: Array<{ code: string; path: unknown[] }> } | null;
	const diagnostic: BackupValidationDiagnostic = { name: typeof error?.name === 'string' ? error.name.slice(0, 80) : 'Error' };
	if (cause instanceof BackupContentError) {
		diagnostic.reason = cause.message;
	}
	else if (cause instanceof SyntaxError) {
		diagnostic.reason = 'invalid_json';
	}
	if (typeof error?.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(error.code)) {
		diagnostic.code = error.code;
	}
	if (Array.isArray(error?.issues)) {
		diagnostic.issues = error.issues.slice(0, 10).map(issue => ({
			code: String(issue.code).slice(0, 80), path: issue.path.slice(0, 8).map(part => String(part).slice(0, 80)),
		}));
	}
	return new BackupValidationError(code, diagnostic);
}
