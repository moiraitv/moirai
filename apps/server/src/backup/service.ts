import { storageFailureMessage } from '../operations/storage-errors.js';
import { BackupOperationError } from './errors.js';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { backupSettingsSchema, backupInfoSchema, UPGRADE_BACKUP_RETENTION, type BackupInfo, type BackupSettings, type BackupStatus, type BackupReview } from '@moirai/shared';
import type { AppConfig } from '../config.js';
import type { Repository } from '../repository/index.js';
import { applicationVersion } from '../version.js';
import { BackupStore } from './store.js';
import { BackupFence } from './fence.js';
import { atomicJson, readJson } from './files.js';
import { runBackupWorker } from './run-worker.js';
import type { BackupManifest } from './format.js';
import { backupWarningSchema, clearBackupWarning, type BackupWarning } from './warnings.js';
import { nextBackupRun } from './schedule.js';
import { stageRestore } from './restore.js';

/** Persist destination scheduling and its timezone; legacy checkpoints re-anchor on startup. */
const scheduleSchema = z.object({ nextRun: z.iso.datetime().nullable(), timeZone: z.string().optional() });
/** Private validated preview and expiry; clients receive only an opaque token and summary. */
interface RestoreReview {
	staging: string;
	expiresAt: number;
	review: BackupReview;
}
/**
 * Own one bounded backup operation, automatic scheduling, independent retention, and private restore
 * previews. All heavyweight work runs in workers; the service drains on application shutdown.
 */
export class BackupService {
	readonly store: BackupStore;
	readonly fence = new BackupFence();
	private settings: BackupSettings = backupSettingsSchema.parse({});
	private nextRun: string | null = null;
	private busy: string | null = null;
	private warning: BackupWarning | null = null;
	private timer: NodeJS.Timeout | null = null;
	private active: Promise<unknown> | null = null;
	private closing = false;
	private restoring = false;
	private readonly reviews = new Map<string, RestoreReview>();

	constructor(private readonly config: AppConfig, private readonly repository: Repository) {
		this.store = new BackupStore(config.backupDir);
	}

	/** Load persisted scheduling once, skipping missed slots without creating catch-up backups. */
	async start(): Promise<void> {
		this.settings = await this.repository.getBackupSettings();
		this.warning = await readJson(path.join(this.config.dataDir, 'backup-warning.json'), backupWarningSchema);
		try {
			// Initialize the next slot before storage cleanup so a volume failure cannot disable scheduling.
			const prior = await readJson(path.join(this.config.dataDir, 'backup-schedule.json'), scheduleSchema);
			const now = new Date().toISOString();
			const previousRun = prior?.timeZone === this.config.timeZone ? prior.nextRun : null;
			this.nextRun = this.settings.enabled
				? previousRun && Date.parse(previousRun) > Date.now() ? previousRun
					: nextBackupRun(now, this.config.timeZone, this.settings.intervalDays, previousRun ?? undefined) : null;
			await this.persistSchedule();
			await this.store.reconcileIncomplete();
			if (!await stat(path.join(this.config.dataDir, 'restore-journal.json')).catch(() => null)) {
				await rm(path.join(this.config.dataDir, 'restore-staging'), { recursive: true, force: true });
			}
			await this.store.prune('upgrade', UPGRADE_BACKUP_RETENTION);
			await this.clearWarning(['storage', 'upgrade-cleanup']);
		}
		catch (error) {
			await this.warn('Backup storage or schedule could not be initialized. Check the backup volume.', error, 'storage');
		}
		this.schedule();
	}

	/** List healthy and damaged archives independently, preserving explicit storage failures. */
	async status(): Promise<BackupStatus> {
		await this.expireReviews();
		return { settings: this.settings, ...await this.store.inventory(), directory: this.config.backupDir,
			timeZone: this.config.timeZone, nextRun: this.nextRun, busy: this.busy, error: this.warning?.message ?? null };
	}

	/** Save policy and re-anchor the next run; retention affects automatic archives only. */
	async saveSettings(value: BackupSettings): Promise<BackupSettings> {
		return await this.exclusive('Saving backup settings', async () => {
			this.settings = await this.repository.setBackupSettings(backupSettingsSchema.parse(value));
			this.nextRun = value.enabled ? nextBackupRun(new Date().toISOString(), this.config.timeZone) : null;
			await this.persistSchedule();
			try {
				await this.store.prune('automatic', value.retention);
				await this.clearWarning(['automatic-cleanup']);
			}
			catch (error) {
				await this.warn('Backup settings were saved, but automatic backup cleanup failed. Check the backup volume.', error, 'automatic-cleanup');
			}
			this.schedule();
			return this.settings;
		});
	}

	/** Persist an explicit dismissal without hiding any future failure. */
	async dismissWarning(): Promise<void> {
		await this.exclusive('Dismissing backup warning', async () => {
			await clearBackupWarning(this.config.dataDir);
			this.warning = null;
		});
	}

	/** Create a manual archive without changing automatic scheduling or retention. */
	async create(): Promise<BackupInfo> {
		return await this.exclusive('Creating backup', () => this.capture('manual'));
	}

	/** Delete a completed archive after the UI has confirmed permanent removal. */
	async delete(id: string): Promise<void> {
		await this.exclusive('Deleting backup', async () => {
			try {
				await this.store.delete(id);
			}
			catch (error) {
				if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
					throw new BackupOperationError('Backup no longer exists', 404);
				}
				throw error;
			}
		});
	}

	/** Upload directly into private staging without buffering the ZIP in the HTTP process. */
	async reviewUpload(upload: (destination: string) => Promise<void>): Promise<BackupReview> {
		return await this.exclusive('Validating backup', async () => {
			const root = path.join(this.config.dataDir, 'restore-staging');
			await mkdir(root, { recursive: true, mode: 0o700 });
			await this.expireReviews();
			// One pending preview bounds temporary disk use between successive uploads.
			for (const prior of this.reviews.values()) {
				await rm(prior.staging, { recursive: true, force: true });
			}
			this.reviews.clear();
			const staging = await mkdtemp(path.join(root, 'review-'));
			try {
				const filename = path.join(staging, 'upload.zip');
				await upload(filename);
				const size = (await stat(filename)).size;
				const { manifest, counts } = await runBackupWorker<{ manifest: BackupManifest; counts: Pick<BackupReview, 'libraries' | 'channels' | 'mediaItems'> }>({ action: 'validate', config: this.config, staging, filename }, undefined, label => {
					this.busy = `Validating backup: ${label}`;
				});
				await rm(filename);
				const id = randomUUID();
				const review: BackupReview = { id, backup: backupInfoSchema.parse({ ...manifest, size }),
					...counts };
				this.reviews.set(id, { staging, expiresAt: Date.now() + 60 * 60 * 1000, review });
				return review;
			}
			catch (error) {
				await rm(staging, { recursive: true, force: true });
				throw error;
			}
		});
	}

	/** Capture recovery and commit intent before the response triggers the application restart. */
	async restore(id: string): Promise<void> {
		await this.exclusive('Preparing restore', async () => {
			await this.expireReviews();
			const preview = this.reviews.get(id);
			if (!preview) {
				throw new BackupOperationError('Restore preview expired; validate the backup again', 422);
			}
			this.fence.enterMaintenance();
			try {
				await this.capture('pre-restore');
				await stageRestore(this.config, preview.staging);
				this.reviews.delete(id);
				this.restoring = true;
			}
			catch (error) {
				this.fence.leaveMaintenance();
				throw error;
			}
		});
	}

	/** Stop future automatic work and wait for the current worker before closing database resources. */
	async close(): Promise<void> {
		this.closing = true;
		if (this.timer) {
			clearTimeout(this.timer);
		}
		await this.active?.catch(() => undefined);
		for (const preview of this.reviews.values()) {
			await rm(preview.staging, { recursive: true, force: true });
		}
		this.reviews.clear();
	}

	/** Serialize rare administrative operations without an unbounded queue. */
	private async exclusive<T>(label: string, action: () => Promise<T>): Promise<T> {
		if (this.busy || this.closing || this.restoring) {
			throw new BackupOperationError('Another backup or restore operation is in progress', 409);
		}
		this.busy = label;
		const active = action();
		this.active = active;
		try {
			return await active;
		}
		finally {
			this.active = null;
			this.busy = null;
		}
	}

	/** Capture stable configuration before compression, always releasing the mutation fence. */
	private async capture(kind: BackupInfo['kind']): Promise<BackupInfo> {
		if (this.config.databasePath === ':memory:') {
			throw new Error('Backups require a persistent database');
		}
		const staging = await this.store.staging();
		const release = await this.fence.capture();
		try {
			return await runBackupWorker<BackupInfo>({ action: 'create', config: this.config, directory: this.config.backupDir, staging, kind, version: applicationVersion }, release);
		}
		finally {
			release();
			await this.store.cleanup(staging);
		}
	}

	/** Schedule bounded timer slices without replaying missed calendar occurrences. */
	private schedule(): void {
		if (this.timer) {
			clearTimeout(this.timer);
		}
		if (this.closing || !this.nextRun) {
			return;
		}
		this.timer = setTimeout(() => void this.tick(), Math.max(1, Math.min(Date.parse(this.nextRun) - Date.now(), 60_000)));
		this.timer.unref();
	}

	/** Advance the checkpoint before work so failures and process exits do not retry the same slot. */
	private async tick(): Promise<void> {
		if (this.nextRun && Date.parse(this.nextRun) <= Date.now()) {
			this.nextRun = nextBackupRun(new Date().toISOString(), this.config.timeZone, this.settings.intervalDays, this.nextRun);
			let failureKind: BackupWarning['kind'] = 'automatic';
			try {
				await this.persistSchedule();
				await this.exclusive('Creating automatic backup', async () => {
					await this.capture('automatic');
					failureKind = 'automatic-cleanup';
					await this.store.prune('automatic', this.settings.retention);
					await this.clearWarning(['automatic', 'automatic-cleanup', 'storage']);
				});
			}
			catch (error) {
				await this.warn('The scheduled backup or retention cleanup failed. Check backup storage; the next run remains scheduled.', error, failureKind);
			}
		}
		this.schedule();
	}

	/** Persist the next scheduled instant independently of backup configuration. */
	private async persistSchedule(): Promise<void> {
		await atomicJson(path.join(this.config.dataDir, 'backup-schedule.json'), { nextRun: this.nextRun, timeZone: this.config.timeZone });
	}

	/** Keep warnings visible across process restarts without logging archive contents or secrets. */
	private async warn(message: string, cause: unknown, kind: BackupWarning['kind']): Promise<void> {
		const diagnostic = storageFailureMessage(cause);
		message = diagnostic ? `${message} ${diagnostic}` : message;
		this.warning = { message, kind };
		await atomicJson(path.join(this.config.dataDir, 'backup-warning.json'), this.warning).catch(() => undefined);
	}

	/** Clear only warnings resolved by a successful backup or retention reconciliation. */
	private async clearWarning(kinds: BackupWarning['kind'][]): Promise<void> {
		if (this.warning && kinds.includes(this.warning.kind)) {
			await clearBackupWarning(this.config.dataDir, kinds);
			this.warning = null;
		}
	}

	/** Remove expired previews before accepting further restore work. */
	private async expireReviews(): Promise<void> {
		for (const [id, preview] of this.reviews) {
			if (preview.expiresAt <= Date.now()) {
				await rm(preview.staging, { recursive: true, force: true });
				this.reviews.delete(id);
			}
		}
	}

}
