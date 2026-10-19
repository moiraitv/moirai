import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import yazl from 'yazl';
import { afterEach, expect, it } from 'vitest';
import { extractArchive } from '@server/backup/extract.js';
import { limitedCopy, recordSizeGuard } from '@server/backup/files.js';
import { BACKUP_MAX_BYTES, BACKUP_MAX_EXPANDED_BYTES, BACKUP_MAX_ENTRIES } from '@moirai/shared';

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) {
		await rm(root, { recursive: true, force: true });
	}
});
async function archive(entries: Array<{ name: string; content: string; mode?: number }>) {
	const root = await mkdtemp(path.join(tmpdir(), 'moirai-zip-validation-'));
	roots.push(root);
	const filename = path.join(root, 'backup.zip');
	const zip = new yazl.ZipFile();
	const output = pipeline(zip.outputStream, createWriteStream(filename));
	for (const entry of entries) {
		zip.addBuffer(Buffer.from(entry.content), entry.name, entry.mode ? { mode: entry.mode } : {});
	}
	zip.end();
	await output;
	return { root, filename, staging: path.join(root, 'staging') };
}
function manifest(content: string) {
	return { formatVersion: 1, id: randomUUID(), createdAt: new Date().toISOString(), kind: 'manual', applicationVersion: '0.6.2', migrations: [], tables: [],
		entries: [{ name: 'ai-settings.json', size: Buffer.byteLength(content), sha256: createHash('sha256').update(content).digest('hex') }] };
}

it('rejects duplicate member paths instead of allowing overwrite during extraction', async () => {
	const value = await archive([{ name: 'ai-settings.json', content: '{}' }, { name: 'ai-settings.json', content: '{}' }]);
	await expect(extractArchive(value.filename, value.staging)).rejects.toThrow('duplicate');
});
it('rejects symbolic links without creating their target', async () => {
	const value = await archive([{ name: 'ai-settings.json', content: '../../outside', mode: 0o120777 }]);
	await expect(extractArchive(value.filename, value.staging)).rejects.toThrow('unsafe');
	expect(await stat(path.join(value.staging, 'ai-settings.json')).catch(() => null)).toBe(null);
});
it('rejects traversal paths from a forged central directory', async () => {
	const value = await archive([{ name: 'safe.json', content: '{}' }]);
	const content = await readFile(value.filename);
	const replaced = Buffer.from(content.toString('latin1').replaceAll('safe.json', '../x.json'), 'latin1');
	await writeFile(value.filename, replaced);
	await expect(extractArchive(value.filename, value.staging)).rejects.toThrow();
	expect(await stat(path.join(value.root, 'x.json')).catch(() => null)).toBe(null);
});
it('rejects encrypted entry flags before reading their contents', async () => {
	const value = await archive([{ name: 'ai-settings.json', content: '{}' }]);
	const bytes = await readFile(value.filename);
	for (let offset = 0; offset < bytes.length - 10; offset += 1) {
		if (bytes.readUInt32LE(offset) === 0x02014b50) {
			bytes.writeUInt16LE(bytes.readUInt16LE(offset + 8) | 1, offset + 8);
		}
	}
	await writeFile(value.filename, bytes);
	await expect(extractArchive(value.filename, value.staging)).rejects.toThrow();
});
it('requires the manifest to match actual bytes and the complete entry set', async () => {
	const value = await archive([{ name: 'ai-settings.json', content: 'changed' }, { name: 'manifest.json', content: JSON.stringify(manifest('original')) }]);
	await expect(extractArchive(value.filename, value.staging)).rejects.toThrow('checksum');
});
it('rejects future archive formats before database import', async () => {
	const value = await archive([{ name: 'ai-settings.json', content: '{}' }, { name: 'manifest.json', content: JSON.stringify({ ...manifest('{}'), formatVersion: 2 }) }]);
	await expect(extractArchive(value.filename, value.staging)).rejects.toThrow();
});
it('enforces actual copied bytes and bounds individual streamed records', async () => {
	const value = await archive([]);
	await expect(limitedCopy(Readable.from([Buffer.alloc(4)]), path.join(value.root, 'limited'), 3)).rejects.toThrow('size limit');
	const guard = recordSizeGuard();
	await expect(pipeline(Readable.from([Buffer.alloc(64 * 1024 ** 2, 65), Buffer.from('A')]), guard, async source => {
		for await (const chunk of source) {
			expect(chunk).toBeDefined();
		}
	})).rejects.toThrow('record exceeds');
	expect(BACKUP_MAX_BYTES).toBeLessThan(BACKUP_MAX_EXPANDED_BYTES);
	expect(BACKUP_MAX_ENTRIES).toBeGreaterThan(0);
});
