import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, type Page } from '@playwright/test';
import type { ProgramConfig, MediaSourcePickerResult } from '@moirai/shared';
import { test } from './fixture';
import { seedLibrary } from './seed';
import { captureThrough } from './capture';
import { waitForLibraryScan } from '../library-scan';

/** Save a real Program for an example-schedule editor capture. */
async function createProgram(page: Page, headers: Record<string, string>, name: string, config: ProgramConfig): Promise<string> {
	const response = await page.request.post('/api/v1/programs', { headers, data: { name, config } });
	expect(response.ok(), await response.text()).toBe(true);
	return (await response.json() as { id: string }).id;
}

/** Capture the authored counts and selected ordering together, after the editor finishes loading. */
async function captureSequence(page: Page, id: string, mode: RegExp, name: string): Promise<void> {
	await page.goto(`/schedules/programs/${id}`);
	await expect(page.locator('.sequence-entry')).toHaveCount(3);
	await expect(page.getByRole('button', { name: mode })).toHaveAttribute('aria-pressed', 'true');
	const end = await page.locator('.strategy-seed-field').count() ? page.locator('.strategy-seed-field') : page.locator('.strategy-card-grid');
	await captureThrough(page, page.locator('.program-editor-main'), end, name);
}

test('captures movie and sitcom schedule recipes', { tag: '@docs-screenshot' }, async ({ page, documentationServer }) => {
	await page.setViewportSize({ width: 1440, height: 1600 });
	const { libraryId, mediaIds, requestHeaders } = await seedLibrary(page, documentationServer.directory);
	const shuffle = await createProgram(page, requestHeaders, 'Movie Shuffle', {
		type: 'content', source: { type: 'collection', libraryId, itemIds: mediaIds, sort: { type: 'date-added', direction: 'asc' } }, strategy: { type: 'shuffle', seed: '' },
	});
	await page.goto(`/schedules/programs/${shuffle}`);
	await expect(page.getByRole('button', { name: /^Shuffle \(no repeats\)/ })).toHaveAttribute('aria-pressed', 'true');
	await page.locator('summary').filter({ hasText: 'Browse media' }).click();
	await captureThrough(page, page.locator('.program-editor-main'), page.locator('.strategy-seed-field'), 'example-movie-shuffle.png');

	// Each double-feature step owns a distinct curated pool and its shuffle progress.
	const moviePrograms: string[] = [];
	for (const [index, name] of ['Adventure Movies', 'Comedy Movies', 'Science Fiction Movies'].entries()) {
		moviePrograms.push(await createProgram(page, requestHeaders, name, {
			type: 'content', source: { type: 'collection', libraryId, itemIds: mediaIds.slice(index * 2, index * 2 + 2), sort: { type: 'date-added', direction: 'asc' } }, strategy: { type: 'shuffle', seed: '' },
		}));
	}
	const doubleFeatures = await createProgram(page, requestHeaders, 'Double Features', {
		type: 'sequence', repeat: true, ordering: { type: 'shuffled-blocks', seed: '' },
		entries: moviePrograms.map(programId => ({ id: randomUUID(), programId, count: 2 })),
	});
	await captureSequence(page, doubleFeatures, /^Shuffled blocks /, 'example-double-features.png');

	// Scan actual episode fixtures so the sitcom references are genuine show Programs.
	const shows = ['Corner Café', 'Flatmates', 'Office Hours'];
	const root = path.join(documentationServer.directory, 'sitcoms');
	for (const name of shows) {
		const directory = path.join(root, name, 'Season 01');
		await mkdir(directory, { recursive: true });
		for (const episode of ['01', '02', '03']) {
			await writeFile(path.join(directory, `${name} S01E${episode}.mp4`), 'documentation fixture');
		}
	}
	const libraryResponse = await page.request.post('/api/v1/libraries', { headers: requestHeaders, data: {
		name: 'Sitcoms', typeKey: 'shows', sourceType: 'on-disk', sourceConfig: { scanRoot: root }, watcherEnabled: false,
	} });
	expect(libraryResponse.ok()).toBe(true);
	const showLibraryId = (await libraryResponse.json() as { id: string }).id;
	await waitForLibraryScan(page, showLibraryId);
	const sourcesResponse = await page.request.get(`/api/v1/libraries/${showLibraryId}/media-source-options?target=groups`);
	expect(sourcesResponse.ok()).toBe(true);
	const sources = await sourcesResponse.json() as MediaSourcePickerResult;
	const sitcomPrograms: string[] = [];
	for (const name of shows) {
		const group = sources.entries.find(entry => entry.group?.title === name)?.group;
		expect(group).toBeDefined();
		sitcomPrograms.push(await createProgram(page, requestHeaders, name, {
			type: 'content', source: { type: 'group-collection', libraryId: showLibraryId, groupIds: [group!.id] }, strategy: { type: 'sequential' },
		}));
	}
	const sitcom = await createProgram(page, requestHeaders, 'Sitcom Rotation', {
		type: 'sequence', repeat: true, ordering: { type: 'balanced-rotation' },
		entries: sitcomPrograms.map((programId, index) => ({ id: randomUUID(), programId, count: index === 0 ? 2 : 1 })),
	});
	await captureSequence(page, sitcom, /^Balanced rotation /, 'example-sitcom-rotation.png');
});
