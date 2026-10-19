import { createWriteStream } from 'node:fs';
import { readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import yazl from 'yazl';
import { backupFilename, type BackupInfo } from '@moirai/shared';
import { extractArchive } from '../../../apps/server/src/backup/extract';
import { documentationNow } from './fixture';

/** Make a real, restorable archive deterministic without changing application runtime clocks. */
export async function normalizeDocumentationBackup(directory: string, backup: BackupInfo): Promise<void> {
	const backups = path.join(directory, 'data', 'backups');
	const source = path.join(backups, backupFilename(backup));
	const staging = path.join(directory, 'backup-fixture');
	await mkdir(staging);
	const manifest = await extractArchive(source, staging);
	manifest.id = '00000000-0000-4000-8000-000000000001';
	manifest.createdAt = documentationNow.toISOString();
	for (const entry of manifest.entries.filter(entry => entry.name.startsWith('tables/'))) {
		const filename = path.join(staging, entry.name);
		const records = (await readFile(filename, 'utf8')).trim().split('\n').filter(Boolean).map(line => {
			const record = JSON.parse(line);
			for (const column of ['created_at', 'updated_at']) {
				if (typeof record[column] === 'string') {
					record[column] = documentationNow.toISOString();
				}
			}
			return JSON.stringify(record);
		});
		const content = records.length ? `${records.join('\n')}\n` : '';
		await writeFile(filename, content);
		entry.size = Buffer.byteLength(content);
		entry.sha256 = createHash('sha256').update(content).digest('hex');
	}
	const zip = new yazl.ZipFile();
	const output = pipeline(zip.outputStream, createWriteStream(path.join(backups, backupFilename(manifest))));
	for (const entry of manifest.entries) {
		zip.addFile(path.join(staging, entry.name), entry.name, { mtime: documentationNow });
	}
	zip.addBuffer(Buffer.from(JSON.stringify(manifest)), 'manifest.json', { mtime: documentationNow });
	zip.end();
	await output;
	await rm(source);
	await rm(staging, { recursive: true });
}
