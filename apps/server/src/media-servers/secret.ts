import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { ensurePrivateDirectory, protectPrivateFile } from '../operations/private-storage.js';
import path from 'node:path';

/** File that holds the HMAC key for loopback media streams. */
const SECRET_FILE = 'media-stream-secret';

/**
 * Load or create the key used to sign loopback media URLs.
 * The key stays on disk and is never placed in playout documents or process arguments.
 */
export async function loadMediaStreamSecret(dataDir: string): Promise<string> {
	ensurePrivateDirectory(dataDir);
	const file = path.join(dataDir, SECRET_FILE);
	protectPrivateFile(file);
	try {
		const current = (await readFile(file, 'utf8')).trim();
		if (current.length >= 32) {
			return current;
		}
	}
	catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
			throw error;
		}
	}

	const next = randomBytes(32).toString('hex');
	await writeFile(file, `${next}\n`, { mode: 0o600 });
	return next;
}
