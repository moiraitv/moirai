import { createHash } from 'node:crypto';
import { open, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Temporal } from '@js-temporal/polyfill';
import type { LiveEvent } from '@moirai/shared';
import type { AppConfig } from '../config.js';
import type { MoiraiDatabase } from '../db/index.js';
import type { SchedulingWorkerPool } from '../scheduling/worker-pool.js';
import type { GuideReadRequest, GuideReadResult } from './read-job.js';
import { CommittedGuideUnavailableError } from './schedule-guide.js';
import { firstDayGuideKey } from './snapshot-key.js';

/** Keep one serialized window per process and one private file on disk. */
const MAX_SNAPSHOT_BYTES = 32 * 1024 * 1024;
/** Two SHA-256 digests separated by a colon and followed by a newline. */
const HEADER_BYTES = 130;
/** Wait for a burst of channel commits to settle before rendering the shared window. */
const REFRESH_DELAY_MS = 750;
/** Retry speculative work when the pool can spare a slot. */
const BUSY_RETRY_MS = 2_000;

/** Cache only validated first-day response bytes and the committed revision they represent. */
interface GuideSnapshot {
	date: string;
	key: string;
	body: Buffer;
}

/** Detect changes to the timeline, authored presentation, and live catalog artwork. */
function affectsSnapshot(event: LiveEvent): boolean {
	return event.type === 'timeline.changed' || event.type === 'channel.changed'
		|| (event.type === 'scheduling.changed' && ['program', 'template', 'assignment', 'guide-template'].includes(event.data.entity))
		|| (event.type === 'scan.changed' && (event.data.affectsProgramming
			|| event.data.status === 'complete' || event.data.status === 'partial'))
		|| (event.type === 'library.changed' && ['created', 'updated', 'deleted'].includes(event.data.change));
}

/** Detect partial or corrupt artifacts before returning bytes to an authenticated client. */
function checksum(body: Buffer): string {
	return createHash('sha256').update(body).digest('hex');
}

/**
 * Own the private, recoverable first-day browser guide. Background builds use spare scheduling
 * capacity, while a miss follows the ordinary guide read and materialization path.
 */
export class FirstDayGuideSnapshot {
	private readonly filename: string;
	private current: GuideSnapshot | null = null;
	private revision = 0;
	private running = false;
	private refreshing = false;
	private refreshTimer: NodeJS.Timeout | undefined;
	private midnightTimer: NodeJS.Timeout | undefined;
	private persisting: Promise<void> | undefined;

	constructor(
		private readonly config: Pick<AppConfig, 'dataDir' | 'timeZone' | 'publicUrl' | 'guideDays'>,
		private readonly db: MoiraiDatabase,
		private readonly workers: Pick<SchedulingWorkerPool, 'canWarmGuide' | 'warmGuide'>,
		private readonly warn: (error: unknown) => void,
	) {
		this.filename = path.join(config.dataDir, 'first-day-guide.snapshot');
	}

	/** Recover a matching snapshot before opening HTTP traffic, then enable background refresh. */
	async start(): Promise<void> {
		if (this.db.$client.memory) {
			return;
		}
		this.running = true;
		const revision = this.revision;
		const request = this.request();
		try {
			await rm(`${this.filename}.tmp`, { force: true });
			const stored = await this.readFile(request);
			if (revision === this.revision && request.startDate === this.today()) {
				this.current = stored;
			}
		}
		catch (error) {
			this.warn(error);
		}
		this.scheduleRefresh();
		this.scheduleMidnight();
	}

	/** Invalidate immediately and batch nearby updates into the next background build. */
	handleEvent(event: LiveEvent): void {
		if (affectsSnapshot(event)) {
			this.invalidate();
		}
	}

	/** Answer today's first-day requests from memory or populate the cache from the ordinary read. */
	async read(request: GuideReadRequest, load: (request: GuideReadRequest) => Promise<GuideReadResult>): Promise<string | Buffer> {
		if (!this.running || request.days !== 1 || request.startDate !== this.today()) {
			return (await load(request)).body;
		}
		if (this.current?.date === request.startDate) {
			return this.current.body;
		}

		const revision = this.revision;
		const result = await load({ ...request, snapshot: true });
		this.accept(request, revision, result);
		return this.current?.date === request.startDate ? this.current.body : result.body;
	}

	/** Finish an admitted disk publication and let the scheduling pool own active worker shutdown. */
	async close(): Promise<void> {
		this.running = false;
		clearTimeout(this.refreshTimer);
		clearTimeout(this.midnightTimer);
		while (this.persisting) {
			await this.persisting;
		}
	}

	/** Resolve the local date used by both the HTTP range and rollover timing. */
	private today(): string {
		return Temporal.Now.plainDateISO(this.config.timeZone).toString();
	}

	/** Render exactly the same range and presentation that the browser would request. */
	private request(): GuideReadRequest {
		const { timeZone, publicUrl, guideDays } = this.config;
		return { kind: 'guide', timeZone, publicUrl, guideDays, startDate: this.today(), days: 1, snapshot: true };
	}

	/** Retire the old revision without delaying its originating mutation. */
	private invalidate(): void {
		this.current = null;
		this.revision += 1;
		this.scheduleRefresh();
	}

	/** Use a calendar boundary so clock changes and DST keep the snapshot on the right local day. */
	private scheduleMidnight(): void {
		const date = Temporal.Now.plainDateISO(this.config.timeZone);
		const midnight = date.add({ days: 1 }).toZonedDateTime(this.config.timeZone).epochMilliseconds;
		this.midnightTimer = setTimeout(() => {
			this.invalidate();
			this.scheduleMidnight();
		}, Math.max(1, midnight - Date.now())).unref();
	}

	/** Admit one trailing refresh for a burst of guide-affecting events. */
	private scheduleRefresh(delay = REFRESH_DELAY_MS): void {
		if (!this.running || !this.workers.canWarmGuide || this.refreshing || this.current) {
			return;
		}
		clearTimeout(this.refreshTimer);
		this.refreshTimer = setTimeout(() => void this.refresh(), delay).unref();
	}

	/** Build from committed rows without kicking off materialization on a speculative read. */
	private async refresh(): Promise<void> {
		if (!this.running || this.current) {
			return;
		}
		const revision = this.revision;
		const request = this.request();
		this.refreshing = true;
		let busy = false;
		try {
			const result = await this.workers.warmGuide(request);
			if (result) {
				this.accept(request, revision, result);
			}
			else {
				busy = true;
			}
		}
		catch (error) {
			if (this.running && !(error instanceof CommittedGuideUnavailableError)) {
				this.warn(error);
			}
		}
		finally {
			this.refreshing = false;
			if (revision !== this.revision || busy) {
				this.scheduleRefresh(busy ? BUSY_RETRY_MS : REFRESH_DELAY_MS);
			}
		}
	}

	/** Publish only the active local date and reject results superseded by an input change. */
	private accept(request: GuideReadRequest, revision: number, result: GuideReadResult): void {
		if (!this.running || this.current?.date === request.startDate || revision !== this.revision
			|| request.startDate !== this.today() || !result.snapshotKey
			|| Buffer.byteLength(result.body) > MAX_SNAPSHOT_BYTES) {
			return;
		}
		this.current = { date: request.startDate, key: result.snapshotKey, body: Buffer.from(result.body) };
		this.persist();
	}

	/** Validate the saved bytes and their durable inputs without starting a scheduling worker. */
	private async readFile(request: GuideReadRequest): Promise<GuideSnapshot | null> {
		const file = await open(this.filename, 'r').catch((error: NodeJS.ErrnoException) => {
			if (error.code !== 'ENOENT') {
				throw error;
			}
			return null;
		});
		if (!file) {
			return null;
		}

		try {
			const stat = await file.stat();
			if (!stat.isFile() || stat.size <= HEADER_BYTES || stat.size > MAX_SNAPSHOT_BYTES + HEADER_BYTES) {
				return null;
			}
			const data = await file.readFile();
			const header = data.subarray(0, HEADER_BYTES).toString('utf8');
			const body = data.subarray(HEADER_BYTES);
			const match = /^([a-f0-9]{64}):([a-f0-9]{64})\n$/u.exec(header);
			if (!match || match[2] !== checksum(body)) {
				return null;
			}
			const key = this.db.$client.transaction(() => firstDayGuideKey(this.db, request))();
			return match[1] === key ? { date: request.startDate, key, body } : null;
		}
		finally {
			await file.close();
		}
	}

	/** Serialize disk writes and atomically replace the artifact with the latest accepted response. */
	private persist(): void {
		const snapshot = this.current;
		if (!snapshot || this.persisting) {
			return;
		}
		const temporary = `${this.filename}.tmp`;
		const header = Buffer.from(`${snapshot.key}:${checksum(snapshot.body)}\n`);
		this.persisting = writeFile(temporary, [header, snapshot.body], { mode: 0o600, flag: 'wx' })
			.then(() => rename(temporary, this.filename))
			.catch(async error => {
				await rm(temporary, { force: true }).catch(() => undefined);
				this.warn(error);
			})
			.finally(() => {
				this.persisting = undefined;
				if (this.current !== snapshot) {
					this.persist();
				}
			});
	}
}
