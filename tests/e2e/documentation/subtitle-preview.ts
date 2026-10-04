import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect } from '@playwright/test';
import { SUBTITLE_PREVIEW_UPDATE_DELAY_MS } from '../../../apps/web/src/subtitle-preview-context';
import { test } from './fixture';
import { seedSchedule } from './seed';
import { captureSection, captureThrough } from './capture';

for (const context of ['channel', 'program', 'nested']) {
	const programContext = context !== 'channel';
	test(`checks subtitle draft selection in ${context} context`, { tag: context === 'nested' ? [] : '@docs-screenshot' }, async ({ page, documentationServer }) => {
		const { libraryId, program, template, channel, requestHeaders } = await seedSchedule(page, documentationServer.directory);
		// Representative indexed metadata lets the real endpoint demonstrate selection without probing files.
		const inventory = [
			{ id: randomUUID(), sourceType: 'embedded', partNumber: 1, streamIndex: 5, codec: 'hdmv_pgs_subtitle', format: null, language: 'eng', title: 'Dialog', isDefault: false, isForced: false, isHearingImpaired: false, isCommentary: false, relativePaths: [], playbackPaths: [] },
			{ id: randomUUID(), sourceType: 'embedded', partNumber: 1, streamIndex: 6, codec: 'hdmv_pgs_subtitle', format: null, language: 'eng', title: 'Songs & Signs', isDefault: true, isForced: true, isHearingImpaired: false, isCommentary: false, relativePaths: [], playbackPaths: [] },
		];
		const database = new DatabaseSync(path.join(documentationServer.directory, 'data', 'moirai.sqlite'));
		try {
			expect(database.prepare('UPDATE media_items SET subtitle_tracks = ? WHERE title = ?').run(JSON.stringify(inventory), 'Moonrise Theater').changes).toBe(1);
		}
		finally {
			database.close();
		}
		const channelPrefs = { policy: 'forced', language: 'en', title: 'Signs' };
		await page.request.patch(`/api/v1/channels/${channel.id}`, { headers: requestHeaders, data: { subtitlePreferences: channelPrefs } });
		let innerId = '';
		let outerId = '';
		if (programContext) {
			for (const [name, childId, preferences] of [['Subtitle inner', program.id, { title: 'Forced' }], ['Subtitle outer', '', { policy: 'any' }]] as const) {
				const response = await page.request.post('/api/v1/programs', { headers: requestHeaders, data: { name,
					config: { type: 'sequence', entries: [{ id: randomUUID(), programId: childId || innerId, count: 1 }], subtitlePreferences: preferences },
				} });
				expect(response.ok(), await response.text()).toBe(true);
				const id = (await response.json()).id as string;
				if (childId) {
					innerId = id;
				}
				else {
					outerId = id;
				}
			}
			if (context === 'nested') {
				await page.goto(`/schedules/templates/${template.id}`);
				await page.locator('.template-slot-fields').getByRole('button', { name: /^Edit / }).first().click();
			}
			else {
				await page.goto(`/schedules/programs/${program.id}`);
			}
			const trigger = page.getByRole('button', { name: /Audio and subtitles/ });
			if (await trigger.getAttribute('aria-expanded') !== 'true') {
				await trigger.click();
			}
		}
		else {
			await page.goto('/channels');
			await page.getByRole('button', { name: 'Edit Moonrise Classics', exact: true }).click();
		}
		await page.getByRole('button', { name: /^Check against media/ }).click();
		const preview = page.getByRole('region', { name: 'Check subtitle selection', exact: true });
		await expect(preview.getByRole('combobox', { name: 'Preview library', exact: true })).toBeVisible();
		if (programContext) {
			await preview.getByRole('combobox', { name: 'Preview channel', exact: true }).selectOption(channel.id);
			await preview.getByRole('combobox', { name: 'Add enclosing sequence', exact: true }).selectOption(innerId);
			await preview.getByRole('combobox', { name: 'Add enclosing sequence', exact: true }).selectOption(outerId);
			await expect(preview.locator('.subtitle-preview-context')).toContainText('Subtitle outer → Subtitle inner → Current program draft');
			await page.getByRole('combobox', { name: 'Subtitle title rule', exact: true }).selectOption('any');
		}
		await preview.getByRole('combobox', { name: 'Preview library', exact: true }).selectOption(libraryId);
		await preview.getByRole('searchbox', { name: 'Search preview videos', exact: true }).fill('a');
		const checked = page.waitForResponse(response => response.url().endsWith('/subtitles/selection-preview') && response.request().method() === 'POST');
		await preview.getByRole('button', { name: /^Moonrise Theater 2024(?: |$)/ }).focus();
		await page.keyboard.press('Enter');
		const response = await checked;
		expect(response.ok(), await response.text()).toBe(true);
		const result = await response.json();
		const denied = await page.request.post('/api/v1/subtitles/selection-preview', { data: { mediaItemId: result.mediaItemId, channelPreferences: {}, programPreferences: [] } });
		expect(denied.status()).toBe(403);
		expect(result.preferences).toEqual(programContext ? { policy: 'any', language: 'en', title: null } : channelPrefs);
		expect(result.parts[0].selectedTrackId).toBe(inventory[programContext ? 0 : 1]!.id);
		await expect(preview.locator('.subtitle-preview-tracks li.selected')).toHaveCount(1);
		await expect(preview.locator('.subtitle-preview-tracks li.selected strong')).toContainText(programContext ? 'Dialog' : 'Songs & Signs');
		await expect(preview.locator('.subtitle-preview-tracks li')).toHaveCount(2);
		const descriptionOffsets = await page.locator('.subtitle-policy-card').evaluateAll(cards => cards.map(card => Math.abs(
			card.querySelector('strong')!.getBoundingClientRect().left - card.querySelector('small')!.getBoundingClientRect().left,
		)));
		expect(descriptionOffsets.every(offset => offset < 1), 'Subtitle card descriptions align with their titles').toBe(true);

		await expect(preview.getByRole('heading', { name: 'Part 1', exact: true })).toHaveCount(0);
		await expect(preview.locator('.subtitle-preview-tracks')).not.toContainText('Part 1');
		if (!programContext) {
			await expect(preview.locator('.subtitle-preview-rejection')).toContainText('Title is missing or does not match; File’s forced flag is missing');
		}
		await page.setViewportSize({ width: 390, height: 844 });
		expect(await preview.locator('.subtitle-preview-tracks').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
		await page.setViewportSize({ width: 1440, height: programContext ? 1400 : 1800 });
		if (context === 'program') {
			await preview.locator('.form-disclosure-trigger').evaluate(element => element.scrollIntoView({ block: 'start' }));
			await captureThrough(page, preview.locator('.form-disclosure-trigger'), preview.locator('.subtitle-preview-selection-hint'), 'program-subtitle-preview.png');
		}
		else if (context === 'channel') {
			await captureSection(page, preview, 'channel-subtitle-preview.png');
		}
		if (context === 'channel') {
			// Exercise the multipart display using the same response contract as the real check.
			await page.route('**/subtitles/selection-preview', route => route.fulfill({ json: { ...result, parts: [result.parts[0], {
				...result.parts[0], number: 2, tracks: result.parts[0].tracks.map((entry: { track: Record<string, unknown> }) => ({ ...entry, track: { ...entry.track, partNumber: 2 } })),
			}] } }));
			await preview.getByRole('button', { name: /^Moonrise Theater 2024(?: |$)/ }).click();
			await expect(preview.getByRole('heading', { name: 'Part 1', exact: true })).toBeVisible();
			await expect(preview.getByRole('heading', { name: 'Part 2', exact: true })).toBeVisible();
			await expect(preview.locator('.subtitle-preview-tracks').first()).toContainText('Part 1');
			await expect(preview.locator('.subtitle-preview-tracks').last()).toContainText('Part 2');
			await page.unroute('**/subtitles/selection-preview');
		}
		await page.getByRole('radio', { name: 'Off', exact: true }).check();
		await expect(preview.locator('.subtitle-preview-result')).toContainText('Ordinary subtitles are off.');
		await page.setViewportSize({ width: 390, height: 844 });
		expect(await preview.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
		await page.route('**/subtitles/selection-preview', route => route.fulfill({ status: 503, json: { message: 'Preview temporarily unavailable' } }));
		await preview.getByRole('button', { name: /^Moonrise Theater 2024(?: |$)/ }).click();
		await expect(preview.getByText('Preview temporarily unavailable', { exact: true })).toBeVisible();
		await preview.getByRole('button', { name: /^Check against media/ }).click();
		await preview.getByRole('button', { name: /^Check against media/ }).click();
		await expect(preview.getByText('Preview temporarily unavailable', { exact: true })).toBeVisible();
	});
}

test('subtitle preview preserves loading states and ignores superseded checks', async ({ page, documentationServer }) => {
	const { libraryId } = await seedSchedule(page, documentationServer.directory);
	await page.goto('/channels');
	await page.getByRole('button', { name: 'Edit Moonrise Classics', exact: true }).click();
	let release!: () => void;
	const pending = new Promise<void>(resolve => release = resolve);
	await page.route('**/api/v1/libraries', async route => {
		await pending;
		await route.continue();
	});
	await page.getByRole('button', { name: /^Check against media/ }).click();
	const preview = page.getByRole('region', { name: 'Check subtitle selection', exact: true });
	await expect(preview.getByText('Loading preview choices…', { exact: true })).toBeVisible();
	await expect(preview.getByText('Add and scan a library to check subtitle selection.')).toHaveCount(0);
	release();
	await preview.getByRole('combobox', { name: 'Preview library', exact: true }).selectOption(libraryId);
	await preview.getByRole('searchbox', { name: 'Search preview videos', exact: true }).fill('Moonrise Theater');
	await expect(preview.getByRole('button', { name: /^Moonrise Theater 2024(?: |$)/ })).toBeVisible();
	let finish!: () => void;
	const delayed = new Promise<void>(resolve => finish = resolve);
	let entered = false;
	let fulfilled = false;
	let checks = 0;
	await page.route('**/subtitles/selection-preview', async route => {
		checks++;
		if (checks > 1) {
			await route.continue();
			return;
		}
		entered = true;
		await delayed;
		await route.fulfill({ status: 200, json: { mediaItemId: route.request().postDataJSON().mediaItemId, title: 'Obsolete result', preferences: { policy: 'off' }, limitations: [], parts: [] } }).catch(() => {});
		fulfilled = true;
	});
	await preview.getByRole('button', { name: /^Moonrise Theater 2024(?: |$)/ }).click();
	await expect.poll(() => entered).toBe(true);
	await page.getByRole('radio', { name: 'Any matching track', exact: true }).check();
	finish();
	await expect.poll(() => fulfilled).toBe(true);
	await expect(preview.locator('.subtitle-preview-result')).toContainText('No subtitle tracks are recorded for this part.');
	expect(checks).toBe(2);
	await expect(preview.getByText('Obsolete result', { exact: true })).toHaveCount(0);
	await expect(preview.getByRole('button', { name: /^Moonrise Theater 2024(?: |$)/ })).toBeEnabled();
});

test('subtitle preview disclosure searches only the first twelve videos and clears obsolete searches', async ({ page, documentationServer }) => {
	const { libraryId } = await seedSchedule(page, documentationServer.directory);
	await page.goto('/channels');
	await page.getByRole('button', { name: 'Edit Moonrise Classics', exact: true }).click();
	const preview = page.getByRole('region', { name: 'Check subtitle selection', exact: true });
	const disclosure = preview.getByRole('button', { name: /^Check against media/ });
	await expect(disclosure).toHaveAttribute('aria-expanded', 'false');
	await expect(preview.getByRole('combobox', { name: 'Preview library', exact: true })).toBeHidden();
	await disclosure.click();
	await preview.getByRole('combobox', { name: 'Preview library', exact: true }).selectOption(libraryId);
	const search = preview.getByRole('searchbox', { name: 'Search preview videos', exact: true });
	const firstPage = page.waitForResponse(response => response.url().includes('/media-source-options?'));
	await search.fill('a');
	const response = await firstPage;
	const url = new URL(response.url());
	expect(url.searchParams.get('page')).toBe('1');
	expect(url.searchParams.get('pageSize')).toBe('12');
	const data = await response.json();
	expect(data.pagination.totalEntries).toBeGreaterThan(12);
	const cards = preview.getByRole('group', { name: 'Preview videos', exact: true }).getByRole('button');
	await expect(cards).toHaveCount(12);
	expect(await cards.locator('strong').allTextContents()).toEqual(data.entries.map((entry: { item: { title: string } }) => entry.item.title));
	await expect(cards.first().locator('.poster')).toHaveCSS('aspect-ratio', '2 / 3');
	await expect(cards.first().locator('img')).toHaveAttribute('src', /variant=card/);
	await expect(preview.getByRole('button', { name: 'Check selection', exact: true })).toHaveCount(0);
	await page.setViewportSize({ width: 390, height: 844 });
	expect(await preview.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
	expect(await preview.locator('.subtitle-preview-videos').evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
	await cards.last().focus();
	await page.keyboard.press('Enter');
	await expect(cards.last()).toHaveAttribute('aria-pressed', 'true');
	await expect(preview.locator('.subtitle-preview-result')).toBeVisible();
	await search.fill('orbital');
	await expect(cards).toHaveCount(1);
	await expect(cards.first().locator('.source-match-context')).toContainText('Matched Plot');

	// An earlier query must not repopulate the carousel after the search is cleared.
	let release!: () => void;
	const pending = new Promise<void>(resolve => release = resolve);
	let entered = false;
	let fulfilled = false;
	await page.route('**/media-source-options?*', async route => {
		entered = true;
		await pending;
		await route.fulfill({ status: 200, json: data });
		fulfilled = true;
	});
	await search.fill('obsolete');
	await expect.poll(() => entered).toBe(true);
	await expect(preview.getByText('Loading preview videos…', { exact: true })).toBeVisible();
	await expect(preview.getByText('No videos match this search.', { exact: true })).toHaveCount(0);
	await search.clear();
	release();
	await expect.poll(() => fulfilled).toBe(true);
	await expect(cards).toHaveCount(0);
	await expect(preview.getByText('Search for a video to check subtitle selection.', { exact: true })).toBeVisible();
	await disclosure.click();
	await expect(search).toBeHidden();
	await expect(disclosure).toHaveAttribute('aria-expanded', 'false');
});

test('subtitle preview coalesces draft edits and pauses invalid or collapsed checks', async ({ page, documentationServer }) => {
	const { libraryId } = await seedSchedule(page, documentationServer.directory);
	await page.goto('/channels');
	await page.getByRole('button', { name: 'Edit Moonrise Classics', exact: true }).click();
	const preview = page.getByRole('region', { name: 'Check subtitle selection', exact: true });
	const disclosure = preview.getByRole('button', { name: /^Check against media/ });
	const submitted: Array<{ channelPreferences: { policy?: string; title?: string | null } }> = [];
	page.on('request', request => {
		if (request.url().endsWith('/subtitles/selection-preview') && request.method() === 'POST') {
			submitted.push(request.postDataJSON());
		}
	});
	await disclosure.click();
	await preview.getByRole('combobox', { name: 'Preview library', exact: true }).selectOption(libraryId);
	await preview.getByRole('searchbox', { name: 'Search preview videos', exact: true }).fill('Moonrise Theater');
	await preview.getByRole('button', { name: /^Moonrise Theater 2024(?: |$)/ }).click();
	await expect(preview.locator('.subtitle-preview-result')).toContainText('Ordinary subtitles are off.');
	// Wait past the coalescing interval to catch an accidental duplicate of the immediate card check.
	await page.waitForTimeout(SUBTITLE_PREVIEW_UPDATE_DELAY_MS + 150);
	expect(submitted).toHaveLength(1);

	await page.getByRole('radio', { name: 'Any matching track', exact: true }).check();
	await page.getByRole('combobox', { name: 'Subtitle title rule', exact: true }).selectOption('specific');
	const title = page.getByRole('textbox', { name: 'Subtitle title contains', exact: true });
	await expect(title).toBeVisible();
	await page.waitForTimeout(SUBTITLE_PREVIEW_UPDATE_DELAY_MS + 150);
	expect(submitted).toHaveLength(1);
	await title.pressSequentially('Signs', { delay: SUBTITLE_PREVIEW_UPDATE_DELAY_MS / 10 });
	await expect(preview.getByText('Checking selection…', { exact: true })).toBeHidden();
	await expect.poll(() => submitted.length).toBe(2);
	expect(submitted[1]!.channelPreferences).toMatchObject({ policy: 'any', title: 'Signs' });
	await expect(preview.getByText('This result is outdated.', { exact: true })).toHaveCount(0);
	await expect(preview.locator('.subtitle-preview-result')).toContainText('No eligible track matches.');

	// Collapsing cancels a queued edit; reopening applies the latest valid settings.
	await page.getByRole('radio', { name: 'Forced only', exact: true }).check();
	await disclosure.click();
	await page.waitForTimeout(SUBTITLE_PREVIEW_UPDATE_DELAY_MS + 150);
	expect(submitted).toHaveLength(2);
	await disclosure.click();
	await expect.poll(() => submitted.length).toBe(3);
	expect(submitted[2]!.channelPreferences).toMatchObject({ policy: 'forced', title: 'Signs' });
	await expect(preview.getByText('This result is outdated.', { exact: true })).toHaveCount(0);
	await title.clear();
	await page.waitForTimeout(SUBTITLE_PREVIEW_UPDATE_DELAY_MS + 150);
	expect(submitted).toHaveLength(3);
	await title.fill('Forced');
	await expect.poll(() => submitted.length).toBe(4);
	expect(submitted[3]!.channelPreferences).toMatchObject({ policy: 'forced', title: 'Forced' });
	await expect(preview.getByText('This result is outdated.', { exact: true })).toHaveCount(0);
});
