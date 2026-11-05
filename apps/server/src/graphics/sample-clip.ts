import { createHash } from 'node:crypto';
import { readFile, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { GraphicsPreset } from '@moirai/shared';
import type { AppConfig } from '../config.js';
import type { Repository } from '../repository/index.js';
import { graphicsFolder, publishGraphicsFile } from './assets.js';
import { parseGraphics } from './document.js';
import { renderGraphicsSampleClip } from './preview.js';

/** Retain the most recently rendered sample clips across server restarts. */
const clipLimit = 32;

/** Reuse a saved clip for this preset revision, or render and publish it atomically. */
export async function getGraphicsSampleClip(config: AppConfig, repository: Repository, preset: GraphicsPreset): Promise<Buffer> {
	const folder = path.join(graphicsFolder(config.dataDir), 'sample-clips');
	const key = createHash('sha256').update(JSON.stringify([3, preset.yaml])).digest('hex');
	const file = path.join(folder, `${key}.mp4`);
	try {
		return await readFile(file);
	}
	catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
			throw error;
		}
	}

	const clip = await renderGraphicsSampleClip(config, repository, parseGraphics(preset.yaml));
	await publishGraphicsFile(file, clip);
	await pruneClips(folder);
	return clip;
}

/** Bound derived storage without touching authored assets or playback snapshots. */
async function pruneClips(folder: string): Promise<void> {
	const names = (await readdir(folder)).filter(name => /^[a-f0-9]{64}\.mp4$/.test(name));
	if (names.length <= clipLimit) {
		return;
	}

	const files = await Promise.all(names.map(async name => {
		const file = path.join(folder, name);
		return { file, modified: (await stat(file).catch(() => undefined))?.mtimeMs ?? 0 };
	}));
	files.sort((left, right) => right.modified - left.modified);
	await Promise.all(files.slice(clipLimit).map(({ file }) => rm(file, { force: true })));
}
