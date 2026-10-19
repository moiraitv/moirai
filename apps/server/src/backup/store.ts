import { readdir, stat, unlink, mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import type { BackupInfo, DamagedBackup } from '@moirai/shared';
import { backupFilename, backupInfoSchema } from '@moirai/shared';
import { readManifest } from './extract.js';
import { storageFailureMessage } from '../operations/storage-errors.js';

/** Recognize timestamped archives and legacy identity-only ZIPs without accepting arbitrary paths. */
const archiveName = /^(?:moirai-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z-)?([a-f0-9-]{36})\.zip$/i;

/** Resolved archive identity remains usable even if the manifest is damaged. */
interface StoredBackup {
	filename: string;
	id: string;
	name: string;
	backup: BackupInfo | null;
}

/** Own only completed managed ZIPs; arbitrary files and interrupted writes are never listed or pruned. */
export class BackupStore {
	constructor(readonly directory: string) {}

	/** Resolve an opaque archive identity across current and legacy filenames. */
	async filename(id: string): Promise<string> {
		backupInfoSchema.shape.id.parse(id);
		const names = (await readdir(this.directory)).filter(name => archiveName.exec(name)?.[1] === id);
		if (!names.length) {
			throw Object.assign(new Error('Backup no longer exists'), { code: 'ENOENT' });
		}
		if (names.length > 1) {
			throw new Error('Multiple stored backups have the same identity');
		}
		return path.join(this.directory, names[0]!);
	}

	/** List readable manifests without decompressing the catalog or media payload. */
	async list(): Promise<BackupInfo[]> {
		return (await this.inventory()).backups;
	}

	/** Report damaged archives separately while preserving access to healthy recovery points. */
	async inventory(): Promise<{ backups: BackupInfo[]; damagedBackups: DamagedBackup[] }> {
		const entries = await this.entries();
		return {
			backups: entries.flatMap(entry => entry.backup ? [entry.backup] : [])
				.sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id)),
			damagedBackups: entries.filter(entry => !entry.backup).map(({ id, name }) => ({ id, name })),
		};
	}

	/** Retain resolved paths and isolate invalid metadata; volume failures remain explicit errors. */
	private async entries(): Promise<StoredBackup[]> {
		await mkdir(this.directory, { recursive: true, mode: 0o700 });
		const result: StoredBackup[] = [];
		for (const name of await readdir(this.directory)) {
			const id = archiveName.exec(name)?.[1];
			if (!id || !backupInfoSchema.shape.id.safeParse(id).success) {
				continue;
			}
			const filename = path.join(this.directory, name);
			let backup: BackupInfo | null = null;
			try {
				const manifest = await readManifest(filename);
				if (name !== `${manifest.id}.zip` && name !== backupFilename(manifest)) {
					throw new Error('Stored backup filename and manifest identity disagree');
				}
				backup = backupInfoSchema.parse({ ...manifest, size: (await stat(filename)).size });
			}
			catch (error) {
				if (storageFailureMessage(error)) {
					throw error;
				}
			}
			result.push({ backup, filename, id, name });
		}
		return result;
	}

	/** Delete only an explicitly selected completed archive. */
	async delete(id: string): Promise<void> {
		await unlink(await this.filename(id));
	}

	/** Remove only the oldest archives in one retention category. */
	async prune(kind: 'automatic' | 'upgrade', retain: number): Promise<void> {
		const backups = (await this.entries()).filter(entry => entry.backup?.kind === kind)
			.sort((left, right) => right.backup!.createdAt.localeCompare(left.backup!.createdAt) || right.backup!.id.localeCompare(left.backup!.id));
		for (const backup of backups.slice(retain)) {
			await unlink(backup.filename);
		}
	}

	/** Remove interrupted private writes at startup before any new backup worker is admitted. */
	async reconcileIncomplete(): Promise<void> {
		await mkdir(this.directory, { recursive: true, mode: 0o700 });
		for (const name of await readdir(this.directory)) {
			if (/^\.work-[A-Za-z0-9]+$/.test(name) || /^[a-f0-9-]{36}\.partial$/i.test(name)) {
				await rm(path.join(this.directory, name), { recursive: true, force: true });
			}
		}
	}

	/** Create private temporary storage on the backup volume, separate from completed archives. */
	async staging(): Promise<string> {
		await mkdir(this.directory, { recursive: true, mode: 0o700 });
		const root = await mkdtemp(path.join(this.directory, '.work-'));
		return root;
	}

	/** Remove an operation's private staging tree after its worker has closed every handle. */
	async cleanup(staging: string): Promise<void> {
		await rm(staging, { recursive: true, force: true });
	}
}
