import { catalogRead, type CatalogReadRequest } from '../repository/catalog-read.js';
import type { PlayoutReadRequest } from '../playback/playout-preparation.js';
import { PlayoutPreparationReader } from '../playback/playout-preparation.js';
import type { MoiraiDatabase } from '../db/index.js';
import { Repository } from '../repository/index.js';
import { invalidateCommittedGuideCache } from '../guide/schedule-guide.js';
import { guideRead, type GuideReadRequest, type GuideReadResult } from '../guide/read-job.js';
import { schedulingRead, type SchedulingReadRequest, type SchedulingReadResult } from './read-jobs.js';

/** Compact interactive queries executed through the scheduling worker pool. */
export type DatabaseReadRequest = SchedulingReadRequest | GuideReadRequest | CatalogReadRequest;
/** Serialized public payload and optional follow-up metadata retained outside the payload. */
export type DatabaseReadResult = SchedulingReadResult & GuideReadResult;

/** Worker-owned repository caches shared across reads and invalidated with authoritative revisions. */
export class DatabaseJobReader {
	readonly repository: Repository;
	/** Full guide retained only on its executing worker. */
	readonly playout: PlayoutPreparationReader;
	private revision = '';
	private catalogRevision = '';

	constructor(private readonly db: MoiraiDatabase) {
		this.repository = new Repository(db, true);
		this.playout = new PlayoutPreparationReader(this.repository);
	}

	/** Refresh read caches after a main-process mutation without querying for cache versions. */
	invalidate(revision: string): void {
		if (revision !== this.revision) {
			const catalogRevision = revision.split(':')[0]!;
			if (catalogRevision !== this.catalogRevision) {
				this.repository.invalidateSchedulingCatalog();
				this.catalogRevision = catalogRevision;
			}
			invalidateCommittedGuideCache();
			this.playout.invalidate();
			this.revision = revision;
		}
	}

	/** Retain a coherent committed snapshot while preparing worker-owned playout. */
	async readPlayout(request: PlayoutReadRequest, revision: string) {
		this.invalidate(revision);
		this.db.$client.exec('BEGIN');
		try {
			return await this.playout.read(request);
		}
		finally {
			this.db.$client.exec('ROLLBACK');
		}
	}

	/** Keep worker reads coherent; the local fallback does not hold the shared writer transaction. */
	async read(request: DatabaseReadRequest, revision: string): Promise<DatabaseReadResult> {
		this.invalidate(revision);
		let snapshot = this.db.$client.readonly;
		const release = (): void => {
			if (snapshot) {
				this.db.$client.exec('ROLLBACK');
				snapshot = false;
			}
		};
		if (snapshot) {
			this.db.$client.exec('BEGIN');
		}
		try {
			if (request.kind === 'catalog') {
				return await catalogRead(this.repository, request);
			}
			return request.kind === 'guide' || request.kind === 'xmltv' || request.kind === 'guide-template' || request.kind === 'channel-guide'
				? await guideRead(this.repository, request, release)
				: await schedulingRead(this.repository, request as SchedulingReadRequest, release);
		}
		finally {
			release();
		}
	}
}
