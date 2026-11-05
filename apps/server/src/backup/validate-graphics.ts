import { readFile, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { graphicsAssetSchema, graphicsDraftSchema } from '@moirai/shared';
import { GRAPHICS_UPLOAD_LIMIT, storeGraphicsAsset } from '../graphics/assets.js';
import { graphicsNameKey, GraphicsRepository, reservedGraphicsPreset, validateGraphicsDocument } from '../repository/graphics.js';
import { storageFailureMessage } from '../operations/storage-errors.js';
import type { MoiraiDatabase } from '../db/index.js';
import type { BackupPaths } from './format.js';
import { BackupContentError } from './errors.js';

/** Validate archived graphics references and managed bytes before staging a restore. */
export async function validateGraphicsBackup(config: BackupPaths, staging: string, sqlite: Database.Database): Promise<void> {
	const repository = new GraphicsRepository(drizzle(sqlite) as MoiraiDatabase);
	const validationRoot = path.join(staging, 'checked-graphics');
	try {
		const assets = repository.assets();
		if (new Set(assets.map(asset => asset.id)).size !== assets.length) {
			throw new Error('A custom graphics asset uses a bundled asset ID');
		}

		const presets = sqlite.prepare('SELECT id, name, name_key AS nameKey, yaml FROM graphics_presets');
		for (const entry of presets.iterate() as Iterable<{ id: string; name: string; nameKey: string; yaml: string }>) {
			const draft = graphicsDraftSchema.parse({ name: entry.name, yaml: entry.yaml });
			if (entry.name !== draft.name || entry.nameKey !== graphicsNameKey(draft.name) || reservedGraphicsPreset(entry.id, entry.nameKey, { allowLegacyName: true })) {
				throw new Error('Invalid graphics preset identity');
			}
			repository.validateAssets(validateGraphicsDocument(draft.yaml));
		}
		for (const row of sqlite.prepare("SELECT json_extract(config, '$.graphicsPresetId') AS id FROM channels").iterate() as Iterable<{ id: string | null }>) {
			if (row.id && !repository.get(row.id)) {
				throw new Error('Missing channel graphics preset');
			}
		}
		repository.validateAssignments(repository.assignments().values());
		const registered = assets.filter(asset => !asset.protected).map(asset => graphicsAssetSchema.parse(asset));
		const files = new Set(registered.map(asset => `${asset.id}.${asset.format}`));
		const archived = await readdir(path.join(staging, 'graphics-assets')).catch((error: NodeJS.ErrnoException) => {
			if (error.code === 'ENOENT') {
				return [];
			}
			throw error;
		});
		if (archived.some(filename => !files.has(filename))) {
			throw new Error('Unregistered graphics asset in backup');
		}
		for (const asset of registered) {
			const filename = `${asset.id}.${asset.format}`;
			const source = path.join(staging, 'graphics-assets', filename);
			let data: Buffer;
			try {
				if ((await stat(source)).size > GRAPHICS_UPLOAD_LIMIT) {
					throw new BackupContentError('Graphics asset exceeds the upload limit');
				}
				data = await readFile(source);
			}
			catch (error) {
				if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
					throw new BackupContentError('Backup is missing a registered graphics asset');
				}
				throw error;
			}
			const checked = await storeGraphicsAsset(validationRoot, filename, data, config.ffprobePath);
			if (checked.kind !== asset.kind || checked.format !== asset.format) {
				throw new Error('Graphics asset does not match its metadata');
			}
			await rm(validationRoot, { recursive: true, force: true });
		}
	}
	catch (error) {
		if (storageFailureMessage(error) || error instanceof BackupContentError) {
			throw error;
		}
		throw new BackupContentError('Backup contains an invalid graphics preset or asset');
	}
	finally {
		await rm(validationRoot, { recursive: true, force: true });
	}
}
