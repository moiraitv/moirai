import { constants } from 'node:fs';
import { copyFile, link, mkdir, readdir, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

/** Maximum retained graphics files per channel, including snapshots pinned by an active session. */
export const GRAPHICS_SNAPSHOT_LIMIT = 512;

/** Bound native snapshot creation across channels and previews. */
const MAX_ACTIVE_SNAPSHOT_CREATIONS = 2;
/** Retain recent unpublished work while leaving most channel capacity for playout leases. */
const MAX_WARMED_SNAPSHOTS = 16;
let activeCreations = 0;

/** A cache miss could not start while other snapshots were being created. */
export class GraphicsSnapshotBusyError extends Error {}

/** Snapshot filenames are derived only from validated asset IDs or rendered text hashes. */
const snapshotName = /^(?:[a-f0-9]{64}\.(?:png|mkv)|[a-f0-9-]{36}\.(?:png|apng|jpeg|gif|webp|mp4|webm))$/;

/** Channel-local state shared by preparation passes while native work completes. */
export interface GraphicsSnapshotRetries {
	pending: Map<string, Promise<void>>;
	warmed: Set<string>;
}

/** Own immutable graphics files published to one channel or disposable preview. */
export class GraphicsSnapshots {
	private constructor(readonly directory: string, private readonly names: Set<string>, private readonly retries?: GraphicsSnapshotRetries) {}

	/** Count retained snapshots before allowing a new preparation pass. */
	static async open(directory: string, retries?: GraphicsSnapshotRetries): Promise<GraphicsSnapshots> {
		const entries = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
			if (error.code === 'ENOENT') {
				return [];
			}
			throw error;
		});
		return new GraphicsSnapshots(directory, new Set(entries.filter(name => snapshotName.test(name))), retries);
	}

	/** Reserve a path before starting optional work, releasing failed reservations for later retries. */
	async use(name: string, create: (destination: string) => Promise<void>): Promise<string> {
		const destination = path.join(this.directory, name);
		const pending = this.retries?.pending.get(name);
		if (pending) {
			await pending;
			return destination;
		}
		if (this.names.has(name) || this.retries?.warmed.has(name)) {
			this.names.add(name);
			return destination;
		}
		if (activeCreations >= MAX_ACTIVE_SNAPSHOT_CREATIONS) {
			throw new GraphicsSnapshotBusyError('Graphics snapshot creation is busy');
		}
		const reserved = new Set([...this.retries?.pending.keys() ?? [], ...this.retries?.warmed ?? []]);
		for (const key of this.names) {
			reserved.delete(key);
		}
		if (this.names.size + reserved.size >= GRAPHICS_SNAPSHOT_LIMIT) {
			throw new Error('Graphics snapshot capacity reached');
		}
		this.names.add(name);
		activeCreations++;
		const work = Promise.resolve().then(() => create(destination)).then(() => {
			const warmed = this.retries?.warmed;
			if (warmed) {
				warmed.add(name);
				if (warmed.size > MAX_WARMED_SNAPSHOTS) {
					warmed.delete(warmed.values().next().value!);
				}
			}
		}).finally(() => {
			activeCreations--;
			this.retries?.pending.delete(name);
		});
		this.retries?.pending.set(name, work);
		try {
			await work;
			return destination;
		}
		catch (error) {
			this.names.delete(name);
			throw error;
		}
	}

	/** Retain managed media independently of its asset-library entry. */
	async media(source: string): Promise<string> {
		return await this.use(path.basename(source), async destination => {
			await mkdir(this.directory, { recursive: true });
			try {
				await link(source, destination);
			}
			catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				if (code === 'EEXIST') {
					return;
				}
				if (code !== 'EXDEV' && code !== 'ENOTSUP' && code !== 'EPERM') {
					throw error;
				}
				const temporary = destination + '.' + randomUUID();
				try {
					await copyFile(source, temporary, constants.COPYFILE_EXCL);
					await rename(temporary, destination);
				}
				finally {
					await rm(temporary, { force: true });
				}
			}
		});
	}

	/** Remove unreferenced files after publishing, once no engine can hold an older document. */
	async prune(used: ReadonlySet<string>): Promise<void> {
		const retained = new Set([...used].map(file => path.basename(file)));
		for (const name of this.names) {
			const file = path.join(this.directory, name);
			if (!retained.has(name)) {
				await rm(file, { force: true });
				this.names.delete(name);
			}
		}
	}
}
