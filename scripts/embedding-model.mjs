import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repository-owned manifest and license sources, independent of the build's working directory. */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** Pinned files required by the local-only inference runtime. */
const manifest = JSON.parse(await readFile(path.join(root, 'apps/server/src/semantic/model-manifest.json'), 'utf8'));

/** Read only checksum-verified bytes; missing or corrupt files must be acquired again at build time. */
async function verifiedFile(filename, hash) {
	const bytes = await readFile(filename).catch((error) => {
		if (error.code === 'ENOENT') {
			return null;
		}
		throw error;
	});
	return bytes && createHash('sha256').update(bytes).digest('hex') === hash ? bytes : null;
}

/** Acquire one pinned build asset, reusing verified files and never replacing it with corrupt bytes. */
export async function acquireModelFile(filename, url, hash, cacheFilename) {
	if (await verifiedFile(filename, hash)) {
		return;
	}
	let bytes = cacheFilename ? await verifiedFile(cacheFilename, hash) : null;
	if (!bytes) {
		const response = await fetch(url);
		if (!response.ok) {
			throw new Error(`Model acquisition failed: ${response.status} (${path.basename(filename)})`);
		}
		bytes = Buffer.from(await response.arrayBuffer());
		if (createHash('sha256').update(bytes).digest('hex') !== hash) {
			throw new Error(`Model checksum mismatch: ${path.basename(filename)}`);
		}
	}
	await mkdir(path.dirname(filename), { recursive: true });
	await writeFile(`${filename}.partial`, bytes);
	await rename(`${filename}.partial`, filename);
}

/** Package the verified model and its license alongside the compiled server, before distribution. */
export async function packageEmbeddingModel(destination = path.join(root, 'apps/server/dist/embedding-model')) {
	for (const [name, hash] of Object.entries(manifest.files)) {
		await acquireModelFile(
			path.join(destination, name),
			`https://huggingface.co/${manifest.repository}/resolve/${manifest.revision}/${name}`,
			hash,
			path.join(root, 'data/models/bge-small-en-v1.5', name),
		);
	}
	await writeFile(path.join(destination, 'LICENSE.txt'), await readFile(path.join(root, 'apps/server/src/semantic/model-LICENSE.txt')));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const destination = path.resolve(process.argv[2] ?? path.join(root, 'apps/server/dist/embedding-model'));
	await packageEmbeddingModel(destination);
	console.log(`Verified bundled embedding model: ${destination}`);
}
