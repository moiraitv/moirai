import { BackupContentError } from './errors.js';
import { spawn } from 'node:child_process';
import { openSourceFile } from '../media/source-file.js';
import { parseMediaProbeOutput, type MediaProbeResult } from '../media/media-probe.js';

/** Probe a validated descriptor with network and secondary-file protocols disabled. */
export async function probeBackupAsset(executable: string, root: string): Promise<MediaProbeResult> {
	const source = await openSourceFile(root, 'asset');
	try {
		const output = await new Promise<string>((resolve, reject) => {
			const child = spawn(executable, [
				'-v', 'error', '-protocol_whitelist', 'fd', '-show_streams', '-show_format', '-of', 'json', '-fd', '4', 'fd:',
			], { stdio: ['ignore', 'pipe', 'ignore', 'ignore', source.handle.fd] });
			const chunks: Buffer[] = [];
			let size = 0;
			let failure: Error | null = null;
			const timeout = setTimeout(() => {
				failure = new BackupContentError('Backup media inspection timed out');
				child.kill('SIGKILL');
			}, 30_000);
			child.stdout!.on('data', (chunk: Buffer) => {
				size += chunk.length;
				if (size > 256 * 1024) {
					failure = new BackupContentError('Backup media inspection output exceeds its limit');
					child.kill('SIGKILL');
				}
				else {
					chunks.push(chunk);
				}
			});
			child.on('error', () => {
				failure = new BackupContentError('Backup media inspector is unavailable'); 
			});
			child.on('close', code => {
				clearTimeout(timeout);
				if (failure || code !== 0) {
					reject(failure ?? new BackupContentError('Backup media is invalid or uses unsupported protocols'));
				}
				else {
					resolve(Buffer.concat(chunks).toString('utf8'));
				}
			});
		});
		return parseMediaProbeOutput(output, source.stat.size);
	}
	finally {
		await source.handle.close();
	}
}
