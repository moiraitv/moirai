import { BackupValidationError, validationFailure } from './errors.js';
import { parentPort, workerData } from 'node:worker_threads';
import type { BackupInfo } from '@moirai/shared';
import type { BackupPaths } from './format.js';
import { createArchive } from './export.js';
import { extractArchive } from './extract.js';
import { prepareDatabase } from './import.js';

/** Worker jobs contain trusted local paths and untrusted archive bytes only. */
export type BackupJob = {
	config: BackupPaths; staging: string;
} & ({ action: 'create'; directory: string; kind: BackupInfo['kind']; version: string }
	| { action: 'validate'; filename: string });

/** Report real validation stages to the service without archive-provided content. */
function progress(label: string): void {
	parentPort?.postMessage({ type: 'progress', label });
}

/** Run expensive record export, compression, extraction, and migration away from live HTTP. */
async function run(job: BackupJob): Promise<unknown> {
	if (job.action === 'create') {
		return await createArchive(job.config, job.directory, job.staging, job.kind, job.version, () => parentPort?.postMessage({ type: 'captured' }));
	}
	progress('Checking archive integrity (1/4)…');
	const manifest = await extractArchive(job.filename, job.staging).catch(error => {
		throw validationFailure('backup_invalid_archive', error);
	});
	const counts = await prepareDatabase(job.config, job.staging, manifest, progress);
	return { manifest, counts };
}
try {
	parentPort?.postMessage({ type: 'result', value: await run(workerData as BackupJob) });
}
catch (error) {
	parentPort?.postMessage({ type: 'failure', message: error instanceof Error ? error.message : 'Backup operation failed', code: (error as NodeJS.ErrnoException | null)?.code, diagnostic: error instanceof BackupValidationError ? error.diagnostic : undefined });
}
