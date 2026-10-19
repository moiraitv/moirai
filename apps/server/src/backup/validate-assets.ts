import { BackupContentError } from './errors.js';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { FALLBACK_FILLER_MIN_DURATION_MILLISECONDS } from '@moirai/shared';
import type { BackupManifest, BackupPaths } from './format.js';

import { storedFallbackFillerSchema, fallbackContentType, fallbackVideoDuration } from '../playback/fallback-filler-store.js';
import { probeBackupAsset } from './probe-asset.js';

/** Validate actual media streams rather than trusting imported sidecar claims. */
export async function validateFallbackAssets(config: BackupPaths, staging: string, manifest: BackupManifest): Promise<void> {
	const entries = new Map(manifest.entries.map(entry => [entry.name, entry]));
	for (const entry of manifest.entries.filter(entry => entry.name.startsWith('fallback-fillers/'))) {
		const root = entry.name.slice(0, entry.name.lastIndexOf('/'));
		const asset = entries.get(`${root}/asset`);
		if (!asset || !entries.has(`${root}/metadata.json`)) {
			throw new BackupContentError('Fallback backup must contain both media and metadata');
		}
		if (!entry.name.endsWith('/metadata.json')) {
			continue;
		}
		if (entry.size > 16_384) {
			throw new BackupContentError('Fallback metadata exceeds its limit');
		}
		const metadata = storedFallbackFillerSchema.parse(JSON.parse(await readFile(path.join(staging, entry.name), 'utf8')));
		if (metadata.fileSizeBytes !== asset.size) {
			throw new BackupContentError('Fallback metadata size does not match its media');
		}

		const probe = await probeBackupAsset(config.ffprobePath, path.join(staging, root));
		const duration = fallbackVideoDuration(probe);
		const video = probe.streams.find(stream => stream.type === 'video' && !stream.isAttachedPicture);
		if (duration === null || duration < FALLBACK_FILLER_MIN_DURATION_MILLISECONDS
			|| duration !== metadata.durationMilliseconds || probe.streams.some(stream => stream.type === 'audio') !== metadata.hasAudio
			|| (metadata.videoStreamIndex !== undefined && metadata.videoStreamIndex !== video?.index)
			|| fallbackContentType(probe, path.extname(metadata.filename).toLowerCase()) !== metadata.contentType) {
			throw new BackupContentError('Fallback media does not match its saved playback metadata');
		}
	}
}
