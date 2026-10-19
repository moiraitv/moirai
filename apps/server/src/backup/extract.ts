import { BackupContentError } from './errors.js';
import { stat, readFile } from 'node:fs/promises';
import path from 'node:path';
import yauzl from 'yauzl';
import { BACKUP_MAX_BYTES, BACKUP_MAX_EXPANDED_BYTES, BACKUP_MAX_ENTRIES } from '@moirai/shared';
import { allowedEntry, manifestSchema, type BackupManifest } from './format.js';
import { fileDigest, limitedCopy } from './files.js';

/** Open ZIPs lazily so archive entry count cannot create unbounded extraction concurrency. */
export async function openArchive(filename: string): Promise<yauzl.ZipFile> {
	if ((await stat(filename)).size > BACKUP_MAX_BYTES) {
		throw new BackupContentError('Compressed backup exceeds 64 GiB');
	}
	return await new Promise((resolve, reject) => {
		yauzl.open(filename, { lazyEntries: true, strictFileNames: true, validateEntrySizes: true, autoClose: false }, (error, zip) => {
			if (error || !zip) {
				reject(error ?? new BackupContentError('Invalid archive'));
				return;
			}
			resolve(zip);
		});
	});
}
/** Read one entry while forwarding parser errors and removing per-entry listeners. */
export async function nextEntry(zip: yauzl.ZipFile): Promise<yauzl.Entry | null> {
	return await new Promise((resolve, reject) => {
		const cleanup = (): void => {
			zip.off('entry', entry);
			zip.off('end', end);
			zip.off('error', error);
		};
		const entry = (value: yauzl.Entry): void => {
			cleanup();
			resolve(value); 
		};
		const end = (): void => {
			cleanup();
			resolve(null); 
		};
		const error = (value: Error): void => {
			cleanup();
			reject(value); 
		};
		zip.once('entry', entry);
		zip.once('end', end);
		zip.once('error', error);
		zip.readEntry();
	});
}
/** Open a decoded member stream using the ZIP parser's size checks. */
export async function entryStream(zip: yauzl.ZipFile, entry: yauzl.Entry): Promise<NodeJS.ReadableStream> {
	return await new Promise((resolve, reject) => zip.openReadStream(entry, (error, stream) => {
		if (error || !stream) {
			reject(error ?? new BackupContentError('Cannot read ZIP entry'));
			return;
		}
		resolve(stream);
	}));
}
/** Inspect only small manifest metadata when listing completed backups. */
export async function readManifest(filename: string): Promise<BackupManifest> {
	const zip = await openArchive(filename);
	try {
		let entry: yauzl.Entry | null;
		while ((entry = await nextEntry(zip))) {
			if (entry.fileName !== 'manifest.json') {
				continue;
			}
			if (entry.uncompressedSize > 64 * 1024 ** 2 || entry.isEncrypted()) {
				throw new BackupContentError('Invalid backup manifest');
			}
			const chunks: Buffer[] = [];
			let bytes = 0;
			for await (const chunk of await entryStream(zip, entry) as AsyncIterable<Buffer>) {
				bytes += chunk.length;
				if (bytes > 64 * 1024 ** 2) {
					throw new BackupContentError('Invalid backup manifest');
				}
				chunks.push(chunk);
			}
			return manifestSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
		}
		throw new BackupContentError('Backup manifest is missing');
	}
	finally {
		zip.close();
	}
}
/** Extract an allowlisted archive privately, then verify every manifest size and checksum. */
export async function extractArchive(filename: string, staging: string): Promise<BackupManifest> {
	const zip = await openArchive(filename);
	const seen = new Set<string>();
	let expanded = 0;
	try {
		if (zip.entryCount > BACKUP_MAX_ENTRIES) {
			throw new BackupContentError('Backup contains too many entries');
		}
		let entry: yauzl.Entry | null;
		while ((entry = await nextEntry(zip))) {
			const name = entry.fileName;
			const type = (entry.externalFileAttributes >>> 16) & 0o170000;
			if (!allowedEntry(name) || seen.has(name) || entry.isEncrypted() || (type !== 0 && type !== 0o100000)) {
				throw new BackupContentError('Backup contains an unsafe, duplicate, or unsupported entry');
			}
			seen.add(name);
			const limit = name === 'manifest.json' ? 64 * 1024 ** 2 : BACKUP_MAX_EXPANDED_BYTES - expanded;
			if (entry.uncompressedSize > limit) {
				throw new BackupContentError('Backup expanded size limit exceeded');
			}
			expanded += await limitedCopy(await entryStream(zip, entry), path.join(staging, name), limit);
		}
	}
	finally {
		zip.close();
	}
	const manifest = manifestSchema.parse(JSON.parse(await readFile(path.join(staging, 'manifest.json'), 'utf8')));
	const expected = new Set(manifest.entries.map(entry => entry.name));
	if (expected.size !== manifest.entries.length || expected.size !== seen.size - 1 || expected.has('manifest.json')) {
		throw new BackupContentError('Backup manifest entries do not match the archive');
	}
	for (const entry of manifest.entries) {
		if (!seen.has(entry.name)) {
			throw new BackupContentError('Backup entry is missing');
		}
		const actual = await fileDigest(path.join(staging, entry.name));
		if (actual.size !== entry.size || actual.sha256 !== entry.sha256) {
			throw new BackupContentError('Backup content checksum mismatch');
		}
	}
	if (new Set(manifest.tables).size !== manifest.tables.length
		|| manifest.tables.some(table => !expected.has(`tables/${table}.ndjson`))
		|| [...expected].some(name => name.startsWith('tables/') && !manifest.tables.some(table => name === `tables/${table}.ndjson`))) {
		throw new BackupContentError('Backup table manifest is inconsistent');
	}
	return manifest;
}
