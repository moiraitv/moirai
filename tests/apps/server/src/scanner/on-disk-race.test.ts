import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Library } from '@moirai/shared';
import { discoverOnDisk } from '@server/scanner/on-disk.js';

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('on-disk scan races', () => {
	it('reports a disappearing media file as an incomplete traversal instead of throwing', async () => {
		const root = await mkdtemp(path.join(tmpdir(), 'moirai-scan-race-'));
		roots.push(root);
		const folder = path.join(root, 'Film');
		await mkdir(folder);
		const media = path.join(folder, 'Film.mkv');
		await writeFile(media, 'video');
		const library = {
			id: crypto.randomUUID(),
			name: 'Movies',
			typeKey: 'movies',
			sourceType: 'on-disk',
			sourceConfig: { scanRoot: root, playbackRoot: null },
			scanIntervalMinutes: 15,
			watcherEnabled: false,
			enabled: true,
			watcherStatus: 'stopped',
			sourceAvailability: 'available',
			sourceAvailabilityUpdatedAt: null,
			reconciliationStatus: 'idle',
			pendingRemovalCount: 0,
			lastScanStartedAt: null,
			lastScanCompletedAt: null,
			lastChangeDetectedAt: null,
			lastIndexedChangeAt: null,
			itemCount: 0,
			warningCount: 0,
			createdAt: '',
			updatedAt: '',
		} satisfies Library;
		const result = await discoverOnDisk(library, {
			statFile: async () => {
				const error = new Error('File disappeared during scan') as NodeJS.ErrnoException;
				error.code = 'ENOENT';
				throw error;
			},
		});
		expect(result.traversalComplete).toBe(false);
		expect(result.items).toEqual([]);
		expect(result.issues).toContainEqual(
			expect.objectContaining({ path: 'Film/Film.mkv', code: 'media_changed_during_scan' }),
		);
	});
});
