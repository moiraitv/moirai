import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, type Stats } from 'node:fs';
import { mkdir, rename, writeFile, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';

/** Write small private state files atomically in their owning directory. */
export async function atomicJson(filename: string, value: unknown): Promise<void> {
	await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
	const temporary = `${filename}.tmp`;
	await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
	await rename(temporary, filename);
}
/** Read optional validated state without hiding corrupted or inaccessible files. */
export async function readJson<T>(filename: string, schema: z.ZodType<T>): Promise<T | null> {
	try {
		return schema.parse(JSON.parse(await readFile(filename, 'utf8')));
	}
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return null;
		}
		throw error;
	}
}
/** Compute checksums incrementally without loading managed media into memory. */
export async function fileDigest(filename: string): Promise<{ size: number; sha256: string }> {
	const hash = createHash('sha256');
	let size = 0;
	for await (const chunk of createReadStream(filename)) {
		size += chunk.length;
		hash.update(chunk);
	}
	return { size, sha256: hash.digest('hex') };
}
/** Stream to private storage while enforcing the actual byte limit. */
export async function limitedCopy(source: NodeJS.ReadableStream, destination: string, maximum: number): Promise<number> {
	let size = 0;
	await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
	await pipeline(source, new Transform({
		transform(chunk: Buffer, _encoding, callback) {
			size += chunk.length;
			callback(size > maximum ? new Error('Backup size limit exceeded') : null, chunk);
		},
	}), createWriteStream(destination, { flags: 'wx', mode: 0o600 }));
	return size;
}

/** Bound each NDJSON record before readline can accumulate an attacker-controlled giant line. */
export function recordSizeGuard(): Transform {
	let length = 0;
	return new Transform({
		transform(chunk: Buffer, _encoding, callback) {
			let offset = 0;
			let newline = chunk.indexOf(10);
			while (newline !== -1) {
				if (length + newline - offset > 64 * 1024 ** 2) {
					callback(new Error('Backup record exceeds 64 MiB'));
					return;
				}
				length = 0;
				offset = newline + 1;
				newline = chunk.indexOf(10, offset);
			}
			length += chunk.length - offset;
			if (length > 64 * 1024 ** 2) {
				callback(new Error('Backup record exceeds 64 MiB'));
				return;
			}
			callback(null, chunk);
		},
	});
}

/** Treat absence as optional while preserving permission and storage errors during replacement. */
export async function optionalStat(filename: string): Promise<Stats | null> {
	try {
		return await stat(filename);
	}
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return null;
		}
		throw error;
	}
}
