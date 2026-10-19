import { backupValidationCodeSchema } from '@moirai/shared';
import { BackupValidationError } from './errors.js';
import { existsSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import type { BackupJob } from './worker.js';

/** Forward capture/stage notifications; resolve after worker exit so SQLite is closed for cleanup. */
export async function runBackupWorker<T>(job: BackupJob, captured: () => void = () => {}, progress: (label: string) => void = () => {}): Promise<T> {
	const compiled = new URL('./backup-worker.js', import.meta.url);
	const url = existsSync(fileURLToPath(compiled)) ? compiled : new URL('./worker.ts', import.meta.url);
	return await new Promise((resolve, reject) => {
		const worker = new Worker(url, { workerData: job, execArgv: url.pathname.endsWith('.ts') ? ['--import', 'tsx'] : [] });
		let failure: Error | undefined;
		let result: T;
		let completed = false;
		worker.on('message', (message) => {
			if (message.type === 'captured') {
				captured();
			}
			else if (message.type === 'progress') {
				progress(message.label);
			}
			else if (message.type === 'failure') {
				const code = backupValidationCodeSchema.safeParse(message.code);
				failure = code.success ? new BackupValidationError(code.data, message.diagnostic)
					: Object.assign(new Error(message.message), { code: typeof message.code === 'string' ? message.code : undefined });
			}
			else if (message.type === 'result') {
				result = message.value as T;
				completed = true;
			}
		});
		worker.on('error', error => {
			failure = error; 
		});
		worker.on('exit', code => {
			if (failure || code !== 0 || !completed) {
				reject(failure ?? new Error('Backup worker stopped before completing'));
			}
			else {
				resolve(result!);
			}
		});
	});
}
