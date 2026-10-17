import { openDB } from 'idb';

/** Serialize file writes and deletion per editor so stale uploads cannot resurrect removed drafts. */
const writes = new Map<string, Promise<void>>();
/** Lazily open local binary recovery storage; ordinary text drafts do not require IndexedDB. */
function database() {
	return openDB('moirai-resource-drafts', 1, {
		upgrade(db) {
			db.createObjectStore('files');
		},
		blocking(_current, _next, event) {
			(event.target as IDBDatabase).close();
		},
	});
}

/** Store only changed file selections; a null revision removes their retained bytes. */
export function writeDraftFiles(key: string, revision: string | null, files: Record<string, File>): Promise<void> {
	const operation = (writes.get(key) ?? Promise.resolve()).catch(() => {}).then(async () => {
		const db = await database();
		try {
			if (revision) {
				await db.put('files', { revision, files }, key);
			}
			else {
				await db.delete('files', key);
			}
		}
		finally {
			db.close();
		}
	});
	writes.set(key, operation);
	void operation.finally(() => {
		if (writes.get(key) === operation) {
			writes.delete(key);
		}
	}).catch(() => {});
	return operation;
}

/** Reject missing or superseded binary recovery instead of claiming the entire draft was restored. */
export async function readDraftFiles(key: string, revision: string): Promise<Record<string, File>> {
	await writes.get(key);
	const db = await database();
	try {
		const entry = await db.get('files', key) as { revision: string; files: Record<string, File> } | undefined;
		if (!entry || entry.revision !== revision || !Object.values(entry.files).every(file => file instanceof File)) {
			throw new Error('Retained files unavailable');
		}
		return entry.files;
	}
	finally {
		db.close();
	}
}
