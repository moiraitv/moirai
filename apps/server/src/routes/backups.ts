import { BackupValidationError, validationFailure } from '../backup/errors.js';
import { readManifest } from '../backup/extract.js';
import { storageFailureMessage } from '../operations/storage-errors.js';
import { z } from 'zod';
import { copyFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { backupFilename, BACKUP_MAX_BYTES, backupSettingsSchema, backupStatusSchema, backupInfoSchema, backupReviewSchema } from '@moirai/shared';
import type { BackupService } from '../backup/service.js';
import { limitedCopy } from '../backup/files.js';
import { apiOperation, responseContent, binaryBodySchema, emptyResponseSchema, idParamsSchema } from './contracts.js';

/** Services required for authenticated backup operations and the process-owned restart boundary. */
interface BackupRouteDependencies {
	backups: BackupService;
	restartAfterRestore?: () => Promise<void>;
}
/** Register the backup API with explicit contracts and the existing authentication/CSRF guard. */
export function registerBackupRoutes(app: FastifyInstance, { backups, restartAfterRestore }: BackupRouteDependencies): void {
	app.get('/api/v1/backups', {
		schema: apiOperation({ operationId: 'getBackups', tags: ['Backups'], summary: 'List backups and automatic backup status',
			response: { 200: responseContent('Backup status', 'application/json', backupStatusSchema) }, errors: [500] }),
	}, async () => backups.status());
	app.delete('/api/v1/backups/warning', {
		schema: apiOperation({ operationId: 'dismissBackupWarning', tags: ['Backups'], summary: 'Dismiss the persisted backup warning',
			response: { 204: responseContent('Warning dismissed', 'application/json', emptyResponseSchema) }, errors: [409, 500] }),
	}, async (_request, reply) => {
		await backups.dismissWarning();
		return reply.status(204).send();
	});
	app.put('/api/v1/backups/settings', {
		schema: apiOperation({ operationId: 'saveBackupSettings', tags: ['Backups'], summary: 'Save automatic backup settings', body: backupSettingsSchema,
			response: { 200: responseContent('Saved policy', 'application/json', backupSettingsSchema) }, errors: [400, 409, 500] }),
	}, async request => backups.saveSettings(backupSettingsSchema.parse(request.body)));
	app.post('/api/v1/backups', {
		schema: apiOperation({ operationId: 'createBackup', tags: ['Backups'], summary: 'Create a retained manual configuration backup',
			response: { 200: responseContent('Created archive', 'application/json', backupInfoSchema) }, errors: [409, 500] }),
	}, async () => backups.create());
	app.get<{ Params: { id: string } }>('/api/v1/backups/:id/download', {
		schema: apiOperation({ operationId: 'downloadBackup', tags: ['Backups'], summary: 'Download a configuration ZIP', params: idParamsSchema,
			response: { 200: responseContent('Configuration ZIP', 'application/zip', binaryBodySchema) }, errors: [404, 500] }),
	}, async (request, reply) => {
		const filename = await backups.store.filename(request.params.id).catch(error => {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
				throw app.httpErrors.notFound('Backup no longer exists');
			}
			throw error;
		});
		const manifest = await readManifest(filename);
		reply.header('Content-Disposition', `attachment; filename="${backupFilename(manifest)}"`);
		return reply.type('application/zip').send(createReadStream(filename));
	});
	app.delete<{ Params: { id: string } }>('/api/v1/backups/:id', {
		schema: apiOperation({ operationId: 'deleteBackup', tags: ['Backups'], summary: 'Permanently delete a saved backup', params: idParamsSchema,
			response: { 204: responseContent('Deleted', 'application/json', emptyResponseSchema) }, errors: [404, 409, 500] }),
	}, async (request, reply) => {
		await backups.delete(request.params.id);
		return reply.status(204).send();
	});
	app.post('/api/v1/backups/import', {
		schema: apiOperation({ operationId: 'validateUploadedBackup', tags: ['Backups'], summary: 'Upload and validate a configuration ZIP before restore',
			description: 'Validation failures return backup_invalid_archive, backup_unsupported_schema, backup_invalid_records, or backup_invalid_assets with a request ID. Storage failures return storage_unavailable.',
			consumes: ['multipart/form-data'], body: z.preprocess(value => value === null ? undefined : value, z.object({ file: binaryBodySchema }).optional()),
			response: { 200: responseContent('Validated restore preview', 'application/json', backupReviewSchema) }, errors: [409, 413, 422, 500, 503] }),
	}, async request => {
		try {
			return await backups.reviewUpload(async destination => {
				const upload = await request.file({ limits: { files: 1, fields: 0, fileSize: BACKUP_MAX_BYTES } });
				if (!upload) {
					throw app.httpErrors.unprocessableEntity('Select a configuration ZIP');
				}
				await limitedCopy(upload.file, destination, BACKUP_MAX_BYTES);
				if (upload.file.truncated) {
					throw app.httpErrors.payloadTooLarge('Backup exceeds 64 GiB');
				}
			});
		}
		catch (error) {
			if (error instanceof BackupValidationError) {
				app.log.warn({ requestId: request.id, validationCode: error.code, diagnostic: error.diagnostic }, 'Backup validation failed');
				throw error;
			}
			if ((error as { statusCode?: number }).statusCode || storageFailureMessage(error)) {
				throw error;
			}
			app.log.warn({ requestId: request.id, validationCode: 'backup_invalid_archive' }, 'Backup validation failed before archive inspection');
			throw validationFailure('backup_invalid_archive', error);
		}
	});
	app.post<{ Params: { id: string } }>('/api/v1/backups/:id/review', {
		schema: apiOperation({ operationId: 'validateStoredBackup', tags: ['Backups'], summary: 'Validate a saved backup before restore',
			description: 'Validation failures return backup_invalid_archive, backup_unsupported_schema, backup_invalid_records, or backup_invalid_assets with a request ID. Storage failures return storage_unavailable.', params: idParamsSchema,
			response: { 200: responseContent('Validated restore preview', 'application/json', backupReviewSchema) }, errors: [404, 409, 422, 500, 503] }),
	}, async request => {
		try {
			return await backups.reviewUpload(async destination => copyFile(await backups.store.filename(request.params.id), destination));
		}
		catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
				throw app.httpErrors.notFound('Backup no longer exists');
			}
			if (error instanceof BackupValidationError) {
				app.log.warn({ requestId: request.id, validationCode: error.code, diagnostic: error.diagnostic }, 'Backup validation failed');
				throw error;
			}
			if ((error as { statusCode?: number }).statusCode || storageFailureMessage(error)) {
				throw error;
			}
			app.log.warn({ requestId: request.id, validationCode: 'backup_invalid_archive' }, 'Backup validation failed before archive inspection');
			throw validationFailure('backup_invalid_archive', error);
		}
	});
	app.post<{ Params: { id: string } }>('/api/v1/backups/reviews/:id/restore', {
		schema: apiOperation({ operationId: 'restoreBackup', tags: ['Backups'], summary: 'Replace configuration and restart application services', params: idParamsSchema,
			response: { 202: responseContent('Restore accepted; reconnect and sign in after restart', 'application/json', emptyResponseSchema) }, errors: [409, 422, 500, 503] }),
	}, async (request, reply) => {
		if (!restartAfterRestore) {
			throw app.httpErrors.serviceUnavailable('Restore restart coordinator is unavailable');
		}
		await backups.restore(request.params.id);

		let restartScheduled = false;
		/** Restart committed restores once, including when response delivery was interrupted. */
		const restart = (): void => {
			if (restartScheduled) {
				return;
			}
			restartScheduled = true;
			reply.raw.off('finish', restart);
			reply.raw.off('close', restart);
			setImmediate(() => void restartAfterRestore().catch(() => app.log.error('Configuration restore failed; restart to resume the staged restore')));
		};
		reply.raw.once('finish', restart);
		reply.raw.once('close', restart);
		if (reply.raw.destroyed || reply.raw.writableFinished) {
			restart();
		}
		return reply.status(202).send();
	});
}
