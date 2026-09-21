import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { waitForLibraryScan } from './library-scan';
import { expect, test, type Locator } from '@playwright/test';
import {
	authenticateAdministrator,
	E2E_ADMIN_PASSWORD,
	E2E_ADMIN_USERNAME,
} from './authentication';

const wideLogoSvg = Buffer.from(
	'<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200"><rect width="400" height="200" fill="#20c997"/></svg>',
);
const posterPng = await readFile(path.resolve('apps/web/src/assets/moirai-logo.png'));

/** Assert the rendered block size of a form control in CSS pixels. */
async function expectControlHeight(control: Locator, expectedHeight: number): Promise<void> {
	await expect.poll(async () => (await control.boundingBox())?.height ?? 0).toBeCloseTo(
		expectedHeight,
		0,
	);
}

test('indexes a library and creates a channel', async ({ page }) => {
	test.setTimeout(180_000);
	const csrfToken = await authenticateAdministrator(page);
	const runId = String(Date.now());
	const libraryName = `E2E Cinema ${runId}`;
	const channelName = `E2E Channel ${runId}`;
	const mediaRoot = path.resolve('test-results/runtime/media');
	await rm(mediaRoot, { recursive: true, force: true });
	await mkdir(mediaRoot, { recursive: true });
	await writeFile(path.join(mediaRoot, 'Broadcast.mp4'), 'fixture');
	await writeFile(
		path.join(mediaRoot, 'Broadcast.nfo'),
		'<movie><title>Broadcast Fixture</title><year>2026</year><plot>A broadcast preview summary.</plot><rating>8.4</rating><userrating>9.1</userrating><genre>Sci-Fi</genre><genre>Drama</genre><director>Jane Director</director><actor><name>Ada Actor</name><role>Host</role><order>1</order></actor><actor><name>Bea Performer</name><order>2</order></actor><actor><name>Cora Player</name><order>3</order></actor><actor><name>Unbilled Player</name></actor></movie>',
	);
	await writeFile(path.join(mediaRoot, 'Companion.mp4'), 'fixture');
	await writeFile(
		path.join(mediaRoot, 'Companion.nfo'),
		'<movie><title>Companion Fixture</title><year>2025</year><genre>Drama</genre></movie>',
	);
	await writeFile(path.join(mediaRoot, 'poster.png'), posterPng);

	let releaseLibraries: (() => void) | undefined;
	const librariesGate = new Promise<void>((resolve) => {
		releaseLibraries = resolve;
	});
	await page.route('**/api/v1/libraries', async (route) => {
		await librariesGate;
		await route.continue();
	});
	await page.goto('/libraries');
	await expect(page.getByRole('status')).toContainText('Loading libraries');
	await expect(page.getByText('Build your first library')).toBeHidden();
	releaseLibraries?.();
	await expect(page.getByRole('status')).toBeHidden();
	await page.unroute('**/api/v1/libraries');
	await page.locator('.resource-empty-state').getByRole('button', { name: 'Add Library' }).click();
	const addLibrary = page.getByRole('button', { name: 'Add and Scan' });
	await expect(addLibrary).toBeDisabled();
	await page.getByLabel('Name').fill(libraryName);
	await page.getByLabel('Path Moirai scans').fill(mediaRoot);
	await expect(addLibrary).toBeEnabled();
	await addLibrary.click();

	const libraryRow = page.locator('.library-row').filter({
		has: page.getByRole('link', { name: `Open library ${libraryName}`, exact: true }),
	});
	await expect(libraryRow).toBeVisible();
	await expect(libraryRow).toContainText('2 indexed');
	const recentMedia = libraryRow.getByRole('link', { name: /Broadcast Fixture/ });
	await expect(recentMedia).toBeVisible();
	await expect(recentMedia).toHaveAttribute('href', /\/items\//);
	await libraryRow.getByRole('link', { name: `Open library ${libraryName}`, exact: true }).click();
	await expect(page.locator('.library-status-panel')).toContainText('Watcher');
	await expect(page.locator('.status-watcher')).toContainText('ready');
	await expect(page.locator('.library-status-panel')).toContainText('Indexed');
	await expect(page.getByRole('button', { name: 'B', exact: true })).toHaveClass(/active/);
	await expect(page.locator('.catalog-footer')).toContainText('100 per page');
	const scanHistoryToggle = page.getByRole('button', { name: 'Last scan: open scan history' });
	const scanHistoryDialog = page.getByRole('dialog', { name: 'Scan history' });
	await expect(scanHistoryDialog).toBeHidden();
	await scanHistoryToggle.click();
	await expect(scanHistoryDialog.locator('article').first()).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(scanHistoryDialog).toBeHidden();
	await expect(scanHistoryToggle).toBeFocused();
	const syncButton = page.getByRole('button', { name: 'Sync library' });
	const settingsButton = page.getByRole('button', { name: 'Library settings' });
	const libraryHeaderSearch = page.getByRole('textbox', { name: new RegExp(`Search ${libraryName}`) });
	const syncBounds = await syncButton.boundingBox();
	const settingsBounds = await settingsButton.boundingBox();
	const searchBounds = await libraryHeaderSearch.boundingBox();
	expect(syncBounds!.x).toBeLessThan(settingsBounds!.x);
	expect(settingsBounds!.x).toBeLessThan(searchBounds!.x);
	expect(Math.abs(settingsBounds!.y + settingsBounds!.height / 2 - (searchBounds!.y + searchBounds!.height / 2))).toBeLessThan(2);
	const scanResponse = page.waitForResponse((response) =>
		response.url().includes('/api/v1/libraries/')
		&& response.url().endsWith('/scans')
		&& response.request().method() === 'POST');
	await syncButton.click();
	expect((await scanResponse).status()).toBe(202);
	const scanStartedToast = page.getByText('Library scan started', { exact: true });
	await expect(scanStartedToast).toBeVisible();
	await expect(scanStartedToast).toBeHidden({ timeout: 7000 });
	await settingsButton.click();
	const librarySettings = page.getByRole('dialog', { name: `Library settings for ${libraryName}` });
	await expect(librarySettings.getByLabel('Name')).toHaveValue(libraryName);
	const saveLibrarySettings = librarySettings.getByRole('button', { name: 'Save', exact: true });
	const resetLibrarySettings = librarySettings.getByRole('button', { name: 'Reset', exact: true });
	await expect(saveLibrarySettings).toBeDisabled();
	await expect(resetLibrarySettings).toBeDisabled();
	await librarySettings.getByLabel('Name').fill(`${libraryName} Draft`);
	await expect(saveLibrarySettings).toBeEnabled();
	await expect(resetLibrarySettings).toBeEnabled();
	await resetLibrarySettings.click();
	await expect(librarySettings.getByRole('button', { name: 'Confirm Reset' })).toBeVisible();
	await librarySettings.getByRole('button', { name: 'Confirm Reset' }).click();
	await expect(librarySettings.getByLabel('Name')).toHaveValue(libraryName);
	await expect(saveLibrarySettings).toBeDisabled();
	await expect(resetLibrarySettings).toBeDisabled();
	const deleteLibrary = librarySettings.getByRole('button', { name: 'Delete Library' });
	await deleteLibrary.click();
	const deleteLibraryDialog = page.getByRole('alertdialog', { name: 'Delete Library?' });
	await expect(deleteLibraryDialog).toBeVisible();
	const confirmDeleteLibrary = deleteLibraryDialog.getByRole('button', { name: 'Delete Library' });
	const deleteConfirmation = deleteLibraryDialog.getByLabel(new RegExp(`Type ${libraryName} to confirm`));
	await expect(confirmDeleteLibrary).toBeDisabled();
	await deleteConfirmation.fill(`${libraryName} mismatch`);
	await expect(confirmDeleteLibrary).toBeDisabled();
	await deleteConfirmation.fill(libraryName);
	await expect(confirmDeleteLibrary).toBeEnabled();
	await deleteLibraryDialog.getByRole('button', { name: 'Cancel' }).click();
	await expect(deleteLibraryDialog).toBeHidden();
	await expect(deleteLibrary).toBeVisible();
	await librarySettings.getByRole('button', { name: 'Close library editor' }).click();
	const movieLibraryUrl = page.url();
	const movieLibraryId = new URL(movieLibraryUrl).pathname.split('/').at(-1)!;

	const librarySortButton = page.getByRole('button', { name: /Sort by: Title/ });
	await librarySortButton.click();
	await expect(page.getByRole('button', { name: 'Date Added', exact: true })).toBeVisible();
	await page.locator('.library-status-panel').click();
	await expect(page.getByRole('button', { name: 'Date Added', exact: true })).toBeHidden();
	await librarySortButton.click();
	await page.getByRole('button', { name: 'Date Added', exact: true }).click();
	await expect(page).toHaveURL(/sort=date-added/);
	await page.getByRole('button', { name: 'Today', exact: true }).click();
	await expect(page).toHaveURL(/dateWindow=today/);
	await page.goBack();
	await expect(page).not.toHaveURL(/dateWindow=/);
	await page.goBack();
	await expect(page).not.toHaveURL(/sort=/);
	/** Wait for contextual facet counts matching the current required and disallowed rules. */
	function waitForGenreFacets(
		included: string[],
		excluded: string[] = [],
	): ReturnType<typeof page.waitForResponse> {
		return page.waitForResponse((response) => {
			const url = new URL(response.url());
			return url.pathname.endsWith('/media-genres')
				&& url.searchParams.get('genreMatch') === 'all'
				&& url.searchParams.getAll('genres').toSorted().join() === included.toSorted().join()
				&& url.searchParams.getAll('excludedGenres').toSorted().join() === excluded.toSorted().join();
		});
	}

	await page.getByRole('button', { name: 'Filter media' }).click();
	await expect(page.getByRole('heading', { name: 'Filter media' })).toBeVisible();
	await expect.poll(async () => {
		const genres = await page.getByRole('heading', { name: 'Genres' }).boundingBox();
		const name = await page.getByLabel('Name').boundingBox();
		return Boolean(genres && name && genres.y < name.y);
	}).toBe(true);
	await expectControlHeight(page.getByRole('group', { name: 'Added', exact: true }).getByLabel('From'), 42);
	await expectControlHeight(page.getByRole('group', { name: 'Added', exact: true }).getByLabel('To'), 42);
	await expectControlHeight(page.getByLabel('Minimum popular rating'), 42);
	await expectControlHeight(page.getByLabel('Minimum user rating'), 42);
	await expect(page.getByText('Narrow down your results using the filters below.')).toBeVisible();
	await expect(page.getByRole('radio', { name: /Match all/ })).toBeChecked();
	await page.getByLabel('Actor').fill('Discarded draft');
	await page.getByRole('button', { name: 'Cancel' }).click();
	const initialGenreFacets = waitForGenreFacets([]);
	await page.getByRole('button', { name: 'Filter media' }).click();
	await initialGenreFacets;
	await expect(page.getByLabel('Actor')).toHaveValue('');
	await page.getByLabel('Actor').fill('Ada');
	const dramaRule = page.getByRole('group', { name: 'Drama rule' });
	const scienceFictionRule = page.getByRole('group', { name: 'Science Fiction rule' });
	await expect(dramaRule.getByRole('button', { name: /Require Drama, 2 matching/ })).toBeVisible();
	await expect(dramaRule.getByRole('button', { name: /Disallow Drama, 0 matching/ })).toBeVisible();
	const requiredScienceFiction = waitForGenreFacets(['science-fiction']);
	await scienceFictionRule.getByRole('button', { name: /Require Science Fiction/ }).click();
	await requiredScienceFiction;
	await expect(page.getByText('Updating genre counts…')).toBeHidden();
	await expect(dramaRule.getByRole('button', { name: /Require Drama, 1 matching/ })).toBeVisible();
	const excludedDrama = waitForGenreFacets(['science-fiction'], ['drama']);
	await dramaRule.getByRole('button', { name: /Disallow Drama/ }).click();
	await excludedDrama;
	await expect(dramaRule.getByRole('button', { name: /Disallow Drama, 0 matching/ }))
		.toHaveAttribute('aria-pressed', 'true');
	await page.getByRole('button', { name: 'Apply filters' }).click();
	await expect(page).toHaveURL(/genre=science-fiction/);
	await expect(page).toHaveURL(/excludeGenre=drama/);
	await expect(page).not.toHaveURL(/genreMatch=/);
	await expect(page.getByText('No matching media')).toBeVisible();
	const restoredExcludedGenres = waitForGenreFacets(['science-fiction'], ['drama']);
	await page.getByRole('button', { name: /Filter/ }).click();
	await restoredExcludedGenres;
	await page.getByRole('radio', { name: /Match any/ }).check();
	await expect(page.getByRole('checkbox', { name: /Science Fiction 1/ })).toBeChecked();
	await expect(page.getByRole('checkbox', { name: /Drama 2/ })).not.toBeChecked();
	const refreshedContextualGenres = waitForGenreFacets(['science-fiction']);
	await page.getByRole('radio', { name: /Match all/ }).check();
	await refreshedContextualGenres;
	await expect(dramaRule.getByRole('button', { name: /Disallow Drama/ }))
		.toHaveAttribute('aria-pressed', 'false');
	const neutralGenres = waitForGenreFacets([]);
	await scienceFictionRule.getByRole('button', { name: /Require Science Fiction/ }).click();
	await neutralGenres;
	await expect(scienceFictionRule.getByRole('button', { name: /Require Science Fiction/ }))
		.toHaveAttribute('aria-pressed', 'false');
	const restoredScienceFiction = waitForGenreFacets(['science-fiction']);
	await scienceFictionRule.getByRole('button', { name: /Require Science Fiction/ }).click();
	await restoredScienceFiction;
	const requiredDrama = waitForGenreFacets(['science-fiction', 'drama']);
	await dramaRule.getByRole('button', { name: /Require Drama/ }).click();
	await requiredDrama;
	await page.getByRole('button', { name: 'Apply filters' }).click();
	await expect(page).toHaveURL(/actor=Ada/);
	await expect(page).toHaveURL(/genre=/);
	await expect(page).not.toHaveURL(/excludeGenre=/);
	await expect(page).not.toHaveURL(/genreMatch=/);

	const mediaCard = page.locator('.media-card').filter({ hasText: 'Broadcast Fixture' });
	await expect(mediaCard).toBeVisible();
	await page.getByRole('button', { name: /Filter/ }).click();
	await page.getByRole('button', { name: 'Clear All' }).click();
	await expect(page.getByLabel('Actor')).toHaveValue('');
	await expect(page).toHaveURL(/actor=Ada/);
	await page.getByLabel('Minimum popular rating').fill('8');
	await page.getByLabel('Minimum user rating').fill('9');
	await page.getByRole('button', { name: 'Apply filters' }).click();
	await expect(page).not.toHaveURL(/actor=/);
	await expect(page).not.toHaveURL(/genre=/);
	await expect(page).toHaveURL(/minimumRating=8/);
	await expect(page).toHaveURL(/minimumUserRating=9/);
	await expect(mediaCard).toBeVisible();
	await expect(page.locator('.media-card').filter({ hasText: 'Companion Fixture' })).toBeHidden();
	await page.getByRole('button', { name: /Filter/ }).click();
	await page.getByRole('button', { name: 'Clear All' }).click();
	await page.getByRole('button', { name: 'Apply filters' }).click();
	await expect(page).not.toHaveURL(/minimumRating=/);
	await expect(page).not.toHaveURL(/minimumUserRating=/);
	await expect(mediaCard).toContainText('2026');
	await expect(mediaCard).not.toContainText(/S\d+E\d+/);
	await expect(mediaCard.locator('.card-menu-icon')).toHaveCount(0);
	const cardPreview = page.getByRole('tooltip');
	await page.mouse.move(0, 0);
	await expect(cardPreview).toBeHidden();
	const mediaCardBounds = await mediaCard.boundingBox();
	expect(mediaCardBounds).not.toBeNull();
	await page.mouse.move(
		mediaCardBounds!.x + mediaCardBounds!.width / 2,
		mediaCardBounds!.y + mediaCardBounds!.height / 2,
	);
	await page.waitForTimeout(150);
	await expect(cardPreview).toBeHidden();
	await expect(cardPreview).toBeVisible();
	await expect(cardPreview).toContainText('Broadcast Fixture');
	await expect(cardPreview).toContainText('2026');
	await expect(cardPreview).toContainText('★ 8.4');
	await expect(cardPreview).toContainText('Sci-Fi');
	await expect(cardPreview).toContainText('A broadcast preview summary.');
	await expect(cardPreview).toContainText('Starring Ada Actor, Bea Performer, Cora Player');
	await page.mouse.move(0, 0);
	await expect(cardPreview).toBeHidden();
	await mediaCard.focus();
	await expect(cardPreview).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(cardPreview).toBeHidden();
	await page.getByRole('button', { name: 'Preview Broadcast Fixture' }).click();
	await expect(cardPreview).toBeVisible();
	await page.getByRole('heading', { name: libraryName }).click();
	await expect(cardPreview).toBeHidden();

	const search = page.getByRole('textbox', { name: new RegExp(`Search ${libraryName}`) });
	await search.fill('No matching title');
	await expect(page.getByText('No matching media')).toBeVisible();
	await expect(page).toHaveURL(/q=No(?:\+|%20)matching(?:\+|%20)title/);
	await search.fill('Broadcast');
	await expect(mediaCard).toBeVisible();
	await page.goBack();
	await expect(page.getByText('No matching media')).toBeVisible();
	await page.goForward();
	await expect(mediaCard).toBeVisible();
	await mediaCard.click();
	await expect(page.getByRole('heading', { name: 'Broadcast Fixture' })).toBeVisible();
	await expect(page.getByText('Science Fiction')).toBeVisible();
	await expect(page.getByText(/Ada Actor/)).toBeVisible();
	await page.goBack();
	await expect(page.locator('.library-nav').getByRole('link', { name: libraryName })).toBeVisible();

	await page.route('**/api/v1/channels', async (route) => {
		await new Promise((resolve) => setTimeout(resolve, 500));
		await route.continue();
	});
	await page.goto('/channels');
	await expect(page.getByRole('status')).toContainText('Loading channels and guide');
	await expect(page.getByText('No channels configured')).toBeHidden();
	await expect(page.getByRole('status')).toBeHidden();
	await page.unroute('**/api/v1/channels');
	await page.goto('/guide');
	await expect(page.getByRole('heading', { name: 'No channels configured' })).toBeVisible();
	await page.getByRole('link', { name: 'Create Channel' }).click();
	await expect(page).toHaveURL(/\/channels\?new=1$/);
	await page.addStyleTag({ content: '.modal, .modal-backdrop { display: none !important; }' });
	await expect(page.getByRole('heading', { name: /(?:Edit|Create) Channel/ })).toBeVisible();
	await page.locator('.channel-encoding-disclosure > button').click();
	await expect(page.locator('.acceleration-prediction')).toBeVisible();
	const saveChannel = page.getByRole('button', { name: 'Save', exact: true });
	const disabledScheduleAction = page.getByRole('button', { name: 'Manage Layered Schedule' });
	await expect(saveChannel).toBeDisabled();
	await expect(page.getByRole('button', { name: 'Delete Channel' })).toHaveCount(0);
	await expect(disabledScheduleAction).toBeDisabled();
	await disabledScheduleAction.locator('..').focus();
	await expect(disabledScheduleAction.locator('..')).toHaveAttribute(
		'aria-label',
		'Manage Layered Schedule',
	);
	await expect(disabledScheduleAction.locator('..')).toHaveAttribute('aria-disabled', 'true');
	await page.getByLabel('Number').fill(runId.slice(-8));
	await page.getByLabel('Name').fill(channelName);
	await expect(saveChannel).toBeEnabled();
	await saveChannel.click();
	await expect(page).toHaveURL(/\/channels$/);
	await expect(page.getByText(channelName)).toBeVisible();
	await expect(page.getByLabel('Seven-day channel guide')).toBeVisible();
	await expect(page.locator('.status-nav-link')).toContainText('IPTV service ready');
	await expect(page.locator('.etv-card')).toHaveCount(0);
	await page.getByRole('button', { name: `Edit ${channelName}` }).click();
	await expect(page.getByRole('heading', { name: /(?:Edit|Create) Channel/ })).toBeVisible();
	await expect(page.getByLabel('Name')).toHaveValue(channelName);
	await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
	await expect(page.getByRole('link', { name: 'Manage Layered Schedule' })).toBeVisible();
	await page.getByLabel('Name').fill(`${channelName} Draft`);
	await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
	await expect(page.getByRole('button', { name: 'Manage Layered Schedule' })).toBeDisabled();
	await page.keyboard.press('Escape');
	const unsavedChannelDialog = page.getByRole('alertdialog', { name: 'Save Changes?' });
	await expect(unsavedChannelDialog.getByRole('button', { name: 'Save Changes' })).toBeVisible();
	await expect(unsavedChannelDialog.getByRole('button', { name: 'Discard Changes' })).toBeVisible();
	await unsavedChannelDialog.getByRole('button', { name: 'Cancel' }).click();
	await expect(unsavedChannelDialog).toBeHidden();
	await expect(page.getByLabel('Name')).toHaveValue(`${channelName} Draft`);
	await page.getByRole('button', { name: 'Delete Channel' }).click();
	const deleteChannelDialog = page.getByRole('alertdialog', { name: 'Delete Channel?' });
	await expect(deleteChannelDialog).toContainText('discard any unsaved changes');
	await deleteChannelDialog.getByRole('button', { name: 'Cancel' }).click();
	await page.getByRole('button', { name: 'Reset', exact: true }).click();
	await page.getByRole('button', { name: 'Confirm Reset' }).click();
	await expect(page.getByLabel('Name')).toHaveValue(channelName);
	await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
	await expect(page.getByRole('link', { name: 'Manage Layered Schedule' })).toBeVisible();
	await page.getByLabel('Name').fill(`${channelName} Edited`);
	await page.locator('input[type="file"][accept*=".mp4"]').setInputFiles({
		name: 'channel-fallback.mp4',
		mimeType: 'video/mp4',
		buffer: Buffer.from('fallback-video-fixture'),
	});
	await expect(page.locator('.fallback-filler-editor')).toContainText('Pending upload');
	await page.locator('input[type="file"][accept="image/*"]').setInputFiles({
		name: 'channel-logo.svg',
		mimeType: 'image/svg+xml',
		buffer: wideLogoSvg,
	});
	await expect(page.getByRole('img', { name: 'Channel logo crop preview' })).toBeVisible();

	const eastHandle = page.getByRole('button', { name: 'Resize crop e', exact: true });
	const handleBox = await eastHandle.boundingBox();
	expect(handleBox).not.toBeNull();
	await page.mouse.move(handleBox!.x + handleBox!.width / 2, handleBox!.y + handleBox!.height / 2);
	await page.mouse.down();
	await page.mouse.move(handleBox!.x - 60, handleBox!.y + handleBox!.height / 2);
	await page.mouse.up();
	await page.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(page.getByText(`${channelName} Edited`)).toBeVisible({ timeout: 15_000 });

	const savedLogo = page
		.locator('.guide-channel-cell')
		.filter({ hasText: `${channelName} Edited` })
		.locator('.guide-channel-logo');
	await expect(savedLogo).toBeVisible();
	const savedLogoUrl = await savedLogo.getAttribute('src');
	expect(savedLogoUrl).toBeTruthy();
	const savedLogoResponse = await page.request.get(new URL(savedLogoUrl!, page.url()).toString());
	expect(savedLogoResponse.ok()).toBe(true);
	const savedLogoPng = Buffer.from(await savedLogoResponse.body());
	expect(savedLogoPng.readUInt32BE(16)).toBeLessThan(400);
	expect(savedLogoPng.readUInt32BE(20)).toBe(200);

	await page.getByRole('button', { name: `Edit ${channelName} Edited` }).click();
	await page.getByLabel('Name').fill(`${channelName} Preserved`);
	await page.getByRole('button', { name: 'Save', exact: true }).click();
	const preservedLogo = page
		.locator('.guide-channel-cell')
		.filter({ hasText: `${channelName} Preserved` })
		.locator('.guide-channel-logo');
	await expect(preservedLogo).toBeVisible();
	const preservedLogoUrl = await preservedLogo.getAttribute('src');
	expect(preservedLogoUrl).toBeTruthy();
	expect((await page.request.get(new URL(preservedLogoUrl!, page.url()).toString())).ok()).toBe(
		true,
	);

	await page.getByRole('button', { name: `Edit ${channelName} Preserved` }).click();
	await page.locator('.channel-fallback-disclosure > button').click();
	const fallbackEditor = page.locator('.fallback-filler-editor');
	await expect(fallbackEditor).toContainText('channel-fallback.mp4');
	await expect(fallbackEditor).toContainText('Includes audio');
	const removeFallback = fallbackEditor.getByRole('button', {
		name: 'Remove fallback filler override',
	});
	await removeFallback.click();
	await page.keyboard.press('Escape');
	await expect(removeFallback).toBeVisible();
	await removeFallback.click();
	await fallbackEditor.getByRole('button', {
		name: 'Confirm remove fallback filler override',
	}).click();
	await expect(fallbackEditor).toContainText('Effective global fallback after save');
	await expect(fallbackEditor).toContainText('dead-air.mp4');
	await expect(fallbackEditor.locator('video')).toBeVisible();
	await page.getByRole('button', { name: 'Close channel editor' }).click();
	await page.getByRole('button', { name: 'Discard Changes' }).click();
	await page.getByRole('button', { name: `Edit ${channelName} Preserved` }).click();
	await expect(page.locator('.fallback-filler-editor')).toContainText('channel-fallback.mp4');
	await page.getByRole('button', { name: 'Close channel editor' }).click();

	await page.route('**/api/v1/channels', async (route) => {
		await new Promise((resolve) => setTimeout(resolve, 500));
		await route.continue();
	});
	await page.getByRole('link', { name: 'Libraries', exact: true }).click();
	const refreshedChannels = page.waitForResponse(
		(response) =>
			response.request().method() === 'GET' && response.url().endsWith('/api/v1/channels'),
	);
	await page.getByRole('link', { name: 'Channels', exact: true }).click();
	await expect(page.getByText(`${channelName} Preserved`)).toBeVisible();
	await expect(page.getByText('Loading channels and guide')).toBeHidden();
	await refreshedChannels;
	await page.unroute('**/api/v1/channels');

	const showsRoot = path.resolve(`test-results/runtime/shows-${runId}`);
	const showDirectory = path.join(showsRoot, 'Space Station');
	const seasonDirectory = path.join(showDirectory, 'Season 01');
	await mkdir(seasonDirectory, { recursive: true });
	await writeFile(
		path.join(showDirectory, 'tvshow.nfo'),
		'<tvshow><title>Space Station</title><year>2020</year></tvshow>',
	);
	await writeFile(path.join(showDirectory, 'poster.png'), posterPng);
	await writeFile(path.join(showDirectory, 'season01-poster.png'), posterPng);
	await writeFile(path.join(seasonDirectory, 'First Contact S01E01.mp4'), 'fixture');
	await writeFile(
		path.join(seasonDirectory, 'First Contact S01E01.nfo'),
		'<episodedetails><title>First Contact</title><season>1</season><episode>1</episode><genre>Sci-Fi</genre><actor><name>Nova Performer</name></actor></episodedetails>',
	);
	const showLibraryResponse = await page.request.post('/api/v1/libraries', {
		headers: { 'x-moirai-csrf': csrfToken },
		data: {
			name: `E2E Shows ${runId}`,
			typeKey: 'shows',
			sourceType: 'on-disk',
			sourceConfig: { scanRoot: showsRoot, playbackRoot: null },
			watcherEnabled: false,
		},
	});
	expect(showLibraryResponse.ok()).toBe(true);
	const showLibrary = (await showLibraryResponse.json()) as { id: string };
	await expect
		.poll(async () => {
			const indexed = (await (
				await page.request.get(`/api/v1/libraries/${showLibrary.id}`)
			).json()) as { itemCount: number };
			return indexed.itemCount;
		})
		.toBe(1);

	await page.route('**/api/v1/scheduling/overview', async (route) => {
		await new Promise((resolve) => setTimeout(resolve, 500));
		await route.continue();
	});
	await page.goto('/schedules/programs');
	await expect(page.getByRole('status')).toContainText('Loading programs');
	await expect(page.getByText('No programs yet')).toBeHidden();
	await expect(page.getByRole('status')).toBeHidden();
	await page.unroute('**/api/v1/scheduling/overview');
	const programHelpHeading = page.getByRole('heading', { name: 'What is a program?' });
	await expect(programHelpHeading).toBeHidden();
	await page.getByRole('button', { name: 'Help with Programs' }).click();
	await expect(programHelpHeading).toBeVisible();
	await expect(page.getByRole('dialog').getByRole('heading', { name: 'Programs', exact: true })).toBeVisible();
	await page.getByRole('button', { name: 'Close help' }).click();

	const programName = `E2E Movie Picks ${runId}`;
	await page.setViewportSize({ width: 768, height: 1024 });
	await page.addStyleTag({ content: '.modal, .modal-backdrop { display: none !important; }' });
	await page.getByRole('link', { name: 'New Program' }).click();
	await expect(page.getByRole('dialog')).toBeVisible();
	const newProgramActionBar = page.locator('.resource-editor-action-bar');
	const newProgramBackdrop = page.locator('.moirai-dialog-backdrop').filter({
		has: newProgramActionBar,
	});
	await expect(newProgramBackdrop).toHaveCSS('position', 'fixed');
	await expect(newProgramBackdrop).toHaveCSS('background-color', 'rgba(2, 7, 12, 0.8)');
	await expect(newProgramActionBar).toHaveCSS('position', 'relative');
	await page.setViewportSize({ width: 1440, height: 900 });
	const programTypes = page.getByRole('radiogroup', { name: 'Program type' });
	await expect(programTypes).toBeVisible();
	await expect(page.getByRole('radio', { name: /Content/ })).toBeChecked();
	const saveProgram = page.getByRole('button', { name: 'Save', exact: true });
	await expect(saveProgram).toBeDisabled();
	await expect(
		page.getByLabel('Source type').getByRole('option', { name: /Exact item/ }),
	).toHaveCount(0);
	const programTypeHeading = await page
		.getByRole('heading', { name: 'Program type', exact: true })
		.boundingBox();
	const firstProgramType = await programTypes.locator('label').first().boundingBox();
	expect(Math.abs((programTypeHeading?.x ?? 0) - (firstProgramType?.x ?? 0))).toBeLessThan(2);
	await expect(page.getByText('Query parameters', { exact: true })).toBeVisible();
	await expect(page.getByLabel('Order by')).toHaveValue('name');
	await expect(page.getByLabel('Direction')).toHaveValue('asc');
	await expect(page.getByLabel('Limit')).toHaveValue('');
	const programQueryPreview = page.getByLabel('Currently matching media');
	await expect(programQueryPreview).toContainText('Broadcast Fixture');
	const queryCards = programQueryPreview.locator('.quick-query-carousel-item');
	expect(await queryCards.count()).toBeGreaterThan(1);
	const queryCardGaps = await queryCards
		.evaluateAll((cards) => cards.slice(0, 3).map((card, index, visibleCards) => {
			if (index === 0) {
				return 0;
			}
			const previous = visibleCards[index - 1]!.getBoundingClientRect();
			const current = card.getBoundingClientRect();
			return current.left - previous.right;
		}));
	expect(queryCardGaps.slice(1).every((gap) => Math.abs(gap) < 1)).toBe(true);
	await page.getByRole('button', { name: 'Configure Filters' }).click();
	const programFilterDialog = page.getByRole('dialog', { name: 'Filter media' });
	await expect(programFilterDialog.getByText('Minimum popular rating')).toBeVisible();
	await expect(programFilterDialog.getByText('Minimum user rating')).toBeVisible();
	await expect(programFilterDialog.getByLabel('Actor')).toBeVisible();
	await expect(programFilterDialog.getByLabel('Director')).toBeVisible();
	await programFilterDialog.getByRole('button', { name: 'Cancel' }).click();
	await expect(page.locator('.filter-modal')).toHaveCount(0);
	await page.getByLabel('Name').fill(programName);
	await page.getByLabel('Source type').selectOption('collection');
	await expect(saveProgram).toBeDisabled();
	await page.getByRole('searchbox', { name: 'Search source media' }).fill('Sci-Fi');
	await page.getByRole('button', { name: 'Search', exact: true }).click();
	const sourceMovie = page
		.locator('.source-picker-list article')
		.filter({ hasText: 'Broadcast Fixture' });
	await expect(sourceMovie).toBeVisible();
	await expect(sourceMovie).toContainText('Matched Genre · Science Fiction');
	await expect(sourceMovie.locator('img')).toBeVisible();
	await expect(sourceMovie.locator('img')).toHaveAttribute('loading', 'eager');
	const sourcePickerTopBeforeSelection = await page
		.locator('.source-picker-list')
		.evaluate((element) => (element as HTMLElement).offsetTop);
	const addMediaButton = sourceMovie.getByRole('button', { name: 'Add' });
	await expect(addMediaButton).toHaveClass(/source-selection-button/);
	await addMediaButton.click();
	await expect(saveProgram).toBeEnabled();
	await expect(sourceMovie.getByRole('button', { name: 'Remove' })).toHaveClass(
		/source-selection-button/,
	);
	await expect(page.getByText('1 selected', { exact: true })).toBeVisible();
	const sourcePickerTopAfterSelection = await page
		.locator('.source-picker-list')
		.evaluate((element) => (element as HTMLElement).offsetTop);
	expect(Math.abs(sourcePickerTopAfterSelection - sourcePickerTopBeforeSelection)).toBeLessThan(2);
	await page.getByRole('searchbox', { name: 'Search source media' }).fill('');
	await page.getByRole('button', { name: 'Search', exact: true }).click();
	const companionMovie = page
		.locator('.source-picker-list article')
		.filter({ hasText: 'Companion Fixture' });
	await companionMovie.getByRole('button', { name: 'Add' }).click();
	await expect(page.getByText('2 selected', { exact: true })).toBeVisible();
	await page.getByRole('button', { name: 'Review Selection' }).click();
	const selectionDrawer = page.getByRole('dialog', { name: 'Review selection' });
	await expect(selectionDrawer).toBeVisible();
	await expect(selectionDrawer.getByLabel('Sort selected media')).toHaveValue('date-added');
	await expect(selectionDrawer.getByLabel('Selected media sort direction')).toHaveValue('asc');
	const selectionDrawerBounds = await selectionDrawer.boundingBox();
	expect(selectionDrawerBounds!.width).toBeGreaterThan(850);
	await selectionDrawer.getByLabel('Sort selected media').selectOption('name');
	await expect(selectionDrawer.locator('.selected-item-copy strong')).toHaveText([
		'Broadcast Fixture',
		'Companion Fixture',
	]);
	await selectionDrawer.getByLabel('Sort selected media').selectOption('manual');
	await expect(selectionDrawer.getByLabel('Selected media sort direction')).toHaveCount(0);
	await selectionDrawer.getByRole('button', { name: 'Move Companion Fixture earlier' }).click();
	await expect(selectionDrawer.locator('.selected-item-copy strong')).toHaveText([
		'Companion Fixture',
		'Broadcast Fixture',
	]);
	await selectionDrawer.getByRole('searchbox', { name: 'Search selected media' }).fill('Broadcast');
	await expect(selectionDrawer.getByText('Clear search to reorder selected media.')).toBeVisible();
	await expect(selectionDrawer.getByRole('button', { name: 'Drag Broadcast Fixture to reorder' }))
		.toBeDisabled();
	await selectionDrawer.getByRole('searchbox', { name: 'Search selected media' }).fill('');
	const selectedMovie = selectionDrawer.locator('.selected-item-grid article').filter({
		hasText: 'Broadcast Fixture',
	});
	await expect(selectedMovie).toContainText('2026');
	await expect(selectedMovie.locator('img')).toBeVisible();
	const removeSelectedMovie = selectedMovie.getByRole('button', {
		name: 'Remove Broadcast Fixture',
	});
	await expect(removeSelectedMovie.locator('svg')).toBeVisible();
	const posterBounds = await selectedMovie.locator('.selected-item-poster').boundingBox();
	const removeBounds = await removeSelectedMovie.boundingBox();
	expect(removeBounds!.y).toBeLessThan((posterBounds?.y ?? 0) + (posterBounds?.height ?? 0) / 3);
	await removeSelectedMovie.click();
	await expect(page.getByText('2 selected', { exact: true })).toBeVisible();
	await selectionDrawer.getByRole('button', { name: 'Confirm remove Broadcast Fixture' }).click();
	const removeCompanion = selectionDrawer.getByRole('button', {
		name: 'Remove Companion Fixture',
	});
	await removeCompanion.click();
	await selectionDrawer.getByRole('button', { name: 'Confirm remove Companion Fixture' }).click();
	await expect(page.getByText('0 selected', { exact: true })).toBeVisible();
	await selectionDrawer.getByRole('button', { name: 'Done' }).click();
	await expect(selectionDrawer).toBeHidden();
	await sourceMovie.getByRole('button', { name: 'Add' }).click();
	await page.getByRole('button', { name: 'Review Selection' }).click();
	const clearAll = selectionDrawer.getByRole('button', { name: 'Clear All' });
	await selectionDrawer.getByRole('button', { name: 'Preview Broadcast Fixture' }).click();
	const pinnedPreview = page.getByRole('tooltip');
	await expect(pinnedPreview).toBeVisible();
	await clearAll.focus();
	await page.keyboard.press('Enter');
	const confirmClear = selectionDrawer.getByRole('button', { name: 'Confirm Clear All' });
	await expect(confirmClear).toHaveClass(/is-armed/);
	await expect(page.getByText('1 selected', { exact: true })).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(clearAll).toBeFocused();
	await expect(confirmClear).toHaveCount(0);
	await page.keyboard.press('Enter');
	await expect(confirmClear).toBeVisible();
	await confirmClear.click();
	await expect(selectionDrawer.getByText('No media selected.')).toBeVisible();
	await selectionDrawer.getByRole('button', { name: 'Done' }).click();
	await sourceMovie.getByRole('button', { name: 'Add' }).click();
	await page.getByLabel('Name').focus();
	await page.keyboard.press('Enter');
	await expect(page).toHaveURL(/\/schedules\/programs$/);
	await page.getByRole('link', { name: 'New Program' }).click();
	await page.getByLabel('Source type').selectOption('group-collection');
	await expect(page.getByLabel('Library', { exact: true })).toHaveValue(showLibrary.id);
	await expect(page.locator('.source-picker-list')).toContainText('Space Station');
	await expect(page.locator('.source-picker-list')).not.toContainText('Broadcast Fixture');
	const showSource = page
		.locator('.source-picker-list article')
		.filter({ hasText: 'Space Station' });
	await showSource.getByRole('button', { name: 'Browse' }).click();
	const seasonSource = page.locator('.source-picker-list article').filter({ hasText: 'Season 1' });
	await seasonSource.getByRole('button', { name: 'Add' }).click();
	await expect(page.locator('.selected-collection-summary')).toContainText('1 selected');
	await page.getByRole('button', { name: 'Review Selection' }).click();
	await expect(page.getByRole('dialog', { name: 'Review selection' })).toContainText('Season 1');
	await page.getByRole('button', { name: 'Done' }).click();
	await expect(page.locator('.selection-drawer-backdrop')).toHaveCount(0);
	await page.getByRole('searchbox', { name: 'Search source media' }).fill('Nova');
	await page.getByRole('button', { name: 'Search', exact: true }).click();
	await expect(page.locator('.source-picker-list')).toContainText('Matched Actor · Nova Performer');
	await expect(page.locator('.source-picker-list')).not.toContainText('First Contact');
	await expect(page.locator('.source-picker-list img').first()).toBeVisible();
	const seasonProgramName = `${programName} Selected Seasons`;
	await page.getByLabel('Name').fill(seasonProgramName);
	await page.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(page).toHaveURL(/\/schedules\/programs$/);
	await page.getByRole('link', { name: 'New Program' }).click();
	await page.getByLabel('Name').fill(`${programName} Follow-up`);
	await page.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(page).toHaveURL(/\/schedules\/programs$/u);
	const programCard = page.locator('.program-row').filter({
		has: page.getByRole('link', { name: programName, exact: true }),
	});
	const seasonProgramCard = page.locator('.program-row').filter({
		has: page.getByRole('link', { name: seasonProgramName, exact: true }),
	});
	await page.getByRole('searchbox', { name: 'Search programs' }).fill('No matching program');
	await expect(page.getByRole('heading', { name: 'No matching programs' })).toBeVisible();
	await page.getByRole('button', { name: 'Clear Filters' }).click();
	await expect(programCard).toBeVisible();
	await expect(seasonProgramCard).toContainText('1 selected media groups');
	const programCarouselItem = programCard.getByRole('link', { name: /Broadcast Fixture/ });
	await expect(programCarouselItem).toHaveCSS('display', 'grid');
	await expect(programCarouselItem).toHaveCSS('background-color', 'rgb(11, 26, 39)');
	await programCarouselItem.click();
	await expect(page).toHaveURL(new RegExp(`/libraries/${movieLibraryId}/items/`));
	await page.goBack();
	await expect(programCard).toBeVisible();
	const programEditAction = programCard.getByRole('link', { name: `Edit ${programName}` });
	await expect(programEditAction).toBeVisible();
	await programEditAction.hover();
	await expect.poll(() => programEditAction.evaluate((element) =>
		getComputedStyle(element).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
	await seasonProgramCard.locator('.program-row-counts').click();
	await page.getByRole('button', { name: 'Review Selection' }).click();
	await expect(page.getByRole('dialog', { name: 'Review selection' })).toContainText('Season 1');
	await page.getByRole('button', { name: 'Done' }).click();
	await page.getByRole('button', { name: 'Close program editor' }).click();
	await expect(programCard).toContainText(`1 selected from ${libraryName}`);
	await programCard.getByRole('link', { name: programName, exact: true }).click();
	await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
	await expect(page.getByRole('button', { name: 'Delete Program' })).toBeVisible();
	await expect(page.locator('.resource-editor-action-bar').getByRole('button')).toHaveText([
		'Delete Program',
		'Reset',
		'Save',
	]);
	await page.getByLabel('Name').fill(`${programName} Draft`);
	await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
	await page.getByRole('button', { name: 'Delete Program' }).click();
	const deleteProgramDialog = page.getByRole('alertdialog', { name: 'Delete Program?' });
	await expect(deleteProgramDialog).toContainText('discard any unsaved changes');
	await deleteProgramDialog.getByRole('button', { name: 'Cancel' }).click();
	await page.getByRole('button', { name: 'Reset', exact: true }).click();
	await page.getByRole('button', { name: 'Confirm Reset' }).click();
	await expect(page.getByLabel('Name')).toHaveValue(programName);
	await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
	await expect(page.getByRole('radio', { name: /Content/ })).toHaveCount(0);
	await expect(page.getByLabel('Source type')).toHaveCount(0);
	await expect(page.getByLabel('Library')).toHaveCount(0);
	await expect(page.locator('.program-type-fixed')).toContainText('Content');
	await expect(page.locator('.program-source-panel')).toContainText('Specific media items');
	await expect(page.locator('.program-source-panel')).toContainText(libraryName);
	await page.getByRole('button', { name: 'Review Selection' }).click();
	await expect(page.getByRole('dialog', { name: 'Review selection' })).toContainText(
		'Broadcast Fixture',
	);
	await page.getByRole('button', { name: 'Done' }).click();

	await page.goto(movieLibraryUrl);
	await page.getByRole('button', { name: 'Select items' }).click();
	await expect(page.getByRole('button', { name: 'Cancel selection', exact: true })).toBeVisible();
	await expect(page.locator('a.media-card').filter({ hasText: 'Companion Fixture' })).toHaveAttribute('tabindex', '-1');
	await expect(page.getByRole('button', { name: 'Add Selected' })).toBeDisabled();
	await expect(page.locator('.catalog-controls-stack')).toHaveCSS('position', 'sticky');
	await expect(page.getByRole('toolbar', { name: 'Item selection' })).toHaveCSS('background-color', 'rgb(8, 43, 37)');
	await expect(page.locator('.catalog-footer')).toHaveCSS('position', 'fixed');
	await expect(page.locator('.catalog-footer')).toHaveCSS('border-radius', '0px');
	const appContentBounds = await page.locator('.app-content').boundingBox();
	const catalogFooterBounds = await page.locator('.catalog-footer').boundingBox();
	expect(Math.abs(catalogFooterBounds!.x - appContentBounds!.x)).toBeLessThan(2);
	expect(Math.abs(catalogFooterBounds!.width - appContentBounds!.width)).toBeLessThan(2);
	await page.getByRole('button', { name: 'Select Companion Fixture' }).click();
	await expect(page.getByText('1 selected', { exact: true })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Add Selected' })).toBeEnabled();
	const librarySearch = page.getByRole('textbox', { name: new RegExp(`Search ${libraryName}`) });
	await librarySearch.fill('Broadcast');
	await expect(page.getByText('0 selected', { exact: true })).toBeVisible();
	await librarySearch.fill('Companion');
	await page.getByRole('button', { name: 'Select Companion Fixture' }).click();
	await page.getByRole('button', { name: 'Add Selected' }).click();
	const addToProgram = page.getByRole('dialog', { name: 'Add to program' });
	await expect(addToProgram).toBeVisible();
	await addToProgram.getByRole('radio', { name: new RegExp(programName) }).check();
	let additionAttempts = 0;
	await page.route('**/api/v1/libraries/*/program-items', async (route) => {
		additionAttempts += 1;
		if (additionAttempts === 1) {
			await route.fulfill({
				status: 409,
				contentType: 'application/json',
				body: JSON.stringify({
					code: 'program_item_confirmation_required',
					message: 'Confirm this program addition',
					details: {
						addedItemCount: 6,
						alreadySelectedCount: 1,
						confirmationToken: 'a'.repeat(64),
						items: Array.from({ length: 6 }, (_, index) => ({
							id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
							title: `Carousel Fixture ${index + 1}`,
							year: 2026,
							artworkUrl: null,
						})),
					},
					requestId: 'e2e-confirmation',
				}),
			});
			return;
		}

		const payload = route.request().postDataJSON() as Record<string, unknown>;
		delete payload.confirmedAdditionToken;
		const response = await route.fetch({ postData: JSON.stringify(payload) });
		await route.fulfill({ response });
	});
	await addToProgram.getByRole('button', { name: 'Add to Program' }).click();
	const additionConfirmation = page.getByRole('alertdialog', { name: 'Confirm addition' });
	await expect(additionConfirmation.getByRole('article')).toHaveCount(6);
	await expect(additionConfirmation.getByText('Carousel Fixture 1')).toBeVisible();
	await expect(additionConfirmation).toContainText('1 item is already selected and will be skipped.');
	await additionConfirmation.getByRole('button', { name: 'Add Items' }).click();
	await expect(page.getByRole('status')).toContainText(`1 added to ${programName}`);
	await page.unroute('**/api/v1/libraries/*/program-items');
	await page.getByRole('button', { name: 'Dismiss' }).click();

	await page.getByRole('button', { name: 'Select items' }).click();
	await page.getByRole('button', { name: 'Add All' }).click();
	await expect(addToProgram.getByRole('radio', { name: new RegExp(programName) })).toBeChecked();
	await addToProgram.getByRole('radio', { name: /Create a new program/ }).check();
	const filteredProgramName = `Z E2E Filtered Picks ${runId}`;
	await addToProgram.getByLabel('Program name').fill(filteredProgramName);
	await addToProgram.getByLabel('Playback order').selectOption('weighted-random');
	await addToProgram.getByRole('button', { name: 'Add to Program' }).click();
	await expect(page.getByRole('status')).toContainText(`1 added to ${filteredProgramName}`);
	await page.getByRole('button', { name: 'Dismiss' }).click();

	await page.locator('.media-card').filter({ hasText: 'Companion Fixture' }).click();
	await page.getByRole('button', { name: 'Add to Program' }).click();
	await expect(addToProgram.getByRole('radio', { name: new RegExp(filteredProgramName) }))
		.toBeChecked();
	await addToProgram.getByRole('radio', { name: new RegExp(programName) }).check();
	await addToProgram.getByRole('button', { name: 'Add to Program' }).click();
	await expect(page.getByRole('status')).toContainText(`Already selected in ${programName}`);
	await page.getByRole('button', { name: 'Dismiss' }).click();

	let templateName = `E2E Daily ${runId}`;
	let timelinePreviewRequests = 0;
	page.on('request', (request) => {
		if (request.method() === 'POST' && request.url().endsWith('/api/v1/timeline-preview')) {
			timelinePreviewRequests += 1;
		}
	});
	await page.setViewportSize({ width: 768, height: 1024 });
	await page.goto('/schedules/templates');
	await page.addStyleTag({ content: '.modal, .modal-backdrop { display: none !important; }' });
	await expect(page.getByRole('heading', { name: 'No templates yet' })).toBeVisible();
	await page.getByRole('link', { name: 'Create Your First Template' }).click();
	await expect(page.getByRole('dialog', { name: 'Template editor' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
	await expect(page.getByRole('button', { name: 'Delete Template' })).toHaveCount(0);
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.getByLabel('Template name').fill(templateName);
	await expect(page.getByLabel('Preview as channel')).toHaveCount(0);
	await expect(page.getByLabel('Preview date')).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Used by', exact: true })).toHaveCount(0);
	await expect(page.locator('.resolved-track')).toBeVisible();
	await expect(page.locator('.resolved-segment small').first()).toContainText(/\d{1,2}:\d{2}/);
	expect(timelinePreviewRequests).toBeGreaterThan(0);
	const editorView = page.getByRole('group', { name: 'Template editor view' });
	await editorView.getByRole('button', { name: 'List', exact: true }).click();
	await page.getByRole('button', { name: 'Add Slot' }).click();
	await expect(editorView.getByRole('button', { name: 'Timeline', exact: true })).toHaveAttribute(
		'aria-pressed',
		'true',
	);
	await expect(page.locator('.slot-placement-marker')).toBeVisible();
	await expect(page.locator('.slot-placement-instructions')).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(page.locator('.slot-placement-instructions')).toBeHidden();
	await expect(page.locator('.template-slot')).toHaveCount(1);

	await page.getByRole('button', { name: 'Add Slot' }).click();
	await page.keyboard.press('ArrowLeft');
	await page.keyboard.press('Enter');
	const editorSlots = page.locator('.template-slot');
	await expect(editorSlots).toHaveCount(2);
	await expect(page.locator('.selected-slot-title')).toContainText('11:45');
	await expectControlHeight(page.getByLabel('Starts'), 42);
	const editorColor = await editorSlots
		.first()
		.evaluate((element) => getComputedStyle(element).getPropertyValue('--program-color').trim());
	expect(
		await editorSlots
			.nth(1)
			.evaluate((element) => getComputedStyle(element).getPropertyValue('--program-color').trim()),
	).toBe(editorColor);

	await page.getByRole('button', { name: 'Add Slot' }).click();
	const firstSlotBounds = await editorSlots.first().boundingBox();
	expect(firstSlotBounds).not.toBeNull();
	await page.mouse.click(
		firstSlotBounds!.x + firstSlotBounds!.width / 2,
		firstSlotBounds!.y + firstSlotBounds!.height / 2,
	);
	await expect(editorSlots).toHaveCount(3);
	await page.getByRole('button', { name: 'Delete selected slot' }).click();
	await expect(editorSlots).toHaveCount(3);
	await page.getByRole('button', { name: 'Confirm delete selected slot' }).click();
	await expect(editorSlots).toHaveCount(2);

	await editorView.getByRole('button', { name: 'List', exact: true }).click();
	await expect(page.locator('.template-slot-list button')).toHaveCount(2);
	await editorView.getByRole('button', { name: 'Timeline', exact: true }).click();
	await expect(
		editorView.getByRole('button', { name: 'Timeline', exact: true }).locator('svg'),
	).toBeVisible();
	await expect(editorSlots).toHaveCount(2);
	const slotForeground = await editorSlots.first().evaluate((element) => {
		const styles = getComputedStyle(element);
		const probe = document.createElement('span');
		probe.style.color = styles.getPropertyValue('--program-color-foreground');
		document.body.append(probe);
		const foreground = getComputedStyle(probe).color;
		probe.remove();
		return {
			foreground,
			slot: styles.color,
			time: getComputedStyle(element.querySelector('small')!).color,
		};
	});
	expect(slotForeground.slot).toBe(slotForeground.foreground);
	expect(slotForeground.time).toBe(slotForeground.foreground);
	const unsavedTemplateName = `${templateName} Draft`;
	await page.getByLabel('Template name').fill(unsavedTemplateName);
	await page.getByRole('button', { name: `Edit ${programName}` }).click();
	const nestedProgramEditor = page.getByRole('dialog', { name: 'Edit Program' });
	await expect(nestedProgramEditor).toBeVisible();
	await expect(nestedProgramEditor.getByRole('button', { name: 'Delete Program' })).toHaveCount(0);
	await nestedProgramEditor.getByLabel('Name').fill(`${programName} Quick Edit`);
	await nestedProgramEditor.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(nestedProgramEditor).toBeHidden();
	await expect(page.getByLabel('Template name')).toHaveValue(unsavedTemplateName);
	await expect(page.getByLabel('Program').first()).toContainText(`${programName} Quick Edit`);
	await page.getByLabel('Template name').fill(templateName);
	await expect(
		page.getByRole('button', { name: 'Toggle advanced scheduling behavior' }),
	).toHaveCount(0);
	const advancedScheduling = page.getByRole('button', { name: 'Advanced scheduling behavior' });
	await advancedScheduling.click();
	await expect(advancedScheduling).toHaveAttribute('aria-expanded', 'true');
	const templateBoundary = page.getByRole('group', { name: /Outgoing boundary at/ });
	await templateBoundary.getByLabel('Policy').selectOption('finish-left');
	await templateBoundary.getByRole('button', { name: 'Use a finite maximum drift' }).click();
	await templateBoundary.getByLabel('Maximum drift in minutes').fill('120');
	await templateBoundary.getByLabel('Fallback').selectOption('favor-right');
	await expect(templateBoundary.getByLabel('Maximum early start (minutes)')).toBeVisible();
	await templateBoundary.getByLabel('Maximum early start (minutes)').fill('75');
	const noLimit = templateBoundary.getByRole('button', { name: 'No Limit', exact: true });
	await noLimit.click();
	await expect(noLimit).toHaveAttribute('aria-pressed', 'true');
	await expect(templateBoundary.getByRole('button', { name: 'Use a finite maximum drift' }))
		.toContainText('120 min');
	await expect(templateBoundary.getByLabel('Fallback')).toBeDisabled();
	await expect(templateBoundary.getByLabel('Maximum early start (minutes)')).toHaveCount(0);
	await expect(page.getByRole('heading', { name: 'Preview resolved schedule' })).toBeVisible();
	await page.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(page).toHaveURL(/\/schedules\/templates$/);
	await expect(page.getByRole('dialog', { name: 'Template editor', exact: true })).toBeHidden();
	await expect(page.locator('.notice.error')).toHaveCount(0);
	await page.getByRole('link', { name: `Edit ${templateName}`, exact: true }).click();
	await page.reload();
	await expect(page.getByLabel('Template name')).toHaveValue(templateName);
	await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
	await expect(page.getByRole('button', { name: 'Delete Template' })).toBeVisible();
	await page.getByLabel('Template name').fill(`${templateName} Draft`);
	await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
	await page.getByRole('button', { name: 'Reset', exact: true }).click();
	await page.getByRole('button', { name: 'Confirm Reset' }).click();
	await expect(page.getByLabel('Template name')).toHaveValue(templateName);
	await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
	await page.getByRole('button', { name: 'Delete Template' }).click();
	const deleteTemplateDialog = page.getByRole('alertdialog', { name: 'Delete Template?' });
	await expect(deleteTemplateDialog).toBeVisible();
	await deleteTemplateDialog.getByRole('button', { name: 'Cancel' }).click();
	await expect(advancedScheduling).toHaveAttribute('aria-expanded', 'true');
	await expect(
		page
			.getByRole('group', { name: /Outgoing boundary at/ })
			.getByRole('button', { name: 'No Limit', exact: true }),
	).toHaveAttribute('aria-pressed', 'true');
	await page.goto('/schedules/channels');
	const channelScheduleHelp = page.getByRole('heading', { name: 'What is a channel schedule?' });
	await expect(channelScheduleHelp).toBeHidden();
	await page.getByRole('button', { name: 'Help with Channel schedules' }).click();
	await expect(channelScheduleHelp).toBeVisible();
	await expect(page.getByRole('dialog').getByRole('heading', { name: 'Channel schedules', exact: true })).toBeVisible();
	await page.getByRole('button', { name: 'Close help' }).click();
	await page.getByRole('searchbox', { name: 'Search channels' }).fill('No matching channel');
	await expect(page.getByRole('heading', { name: 'No matching channels' })).toBeVisible();
	await page.getByRole('button', { name: 'Clear search' }).click();
	const channelScheduleCard = page
		.locator('.schedule-channel-card')
		.filter({ hasText: `${channelName} Preserved` });
	await expect(channelScheduleCard.locator('.schedule-channel-icon img')).toBeVisible();
	await expect(channelScheduleCard.locator('.schedule-channel-title a')).toHaveCount(0);
	await expect(channelScheduleCard.locator('.schedule-channel-open')).toHaveCount(0);
	await channelScheduleCard.getByRole('link', { name: 'Add template' }).click();
	await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
	await expect(page.getByRole('button', { name: 'Delete Channel Schedule' })).toHaveCount(0);
	const applyAfterCurrent = page.getByRole('button', { name: 'Apply After Current Item' });
	await expect(applyAfterCurrent).toBeDisabled();
	await applyAfterCurrent.locator('..').focus();
	await expect(applyAfterCurrent.locator('..')).toHaveAttribute(
		'aria-label',
		'Apply After Current Item',
	);
	await expect(applyAfterCurrent.locator('..')).toHaveAttribute('aria-disabled', 'true');
	await page.getByLabel('Base template', { exact: true }).selectOption({ label: templateName });
	await page.getByRole('button', { name: 'Add conditional template' }).click();
	await expect(page.locator('.schedule-layer.conditional')).toHaveCount(1);
	const armLayerRemoval = page.getByRole('button', { name: 'Remove layer' });
	await armLayerRemoval.click();
	const confirmLayerRemoval = page.getByRole('button', { name: 'Confirm remove layer' });
	await expect(confirmLayerRemoval).toHaveClass(/armed/);
	await expect(page.locator('.schedule-layer.conditional')).toHaveCount(1);
	await confirmLayerRemoval.click();
	await expect(page.locator('.schedule-layer.conditional')).toHaveCount(0);
	await page.getByRole('button', { name: 'Add conditional template' }).click();
	await expect(page.locator('.schedule-layer.conditional')).toHaveCount(1);
	await expect(page.locator('.channel-schedule-save-state')).toContainText('Unsaved changes');
	const conditionalLayer = page.locator('.schedule-layer.conditional');
	await expect(conditionalLayer.getByRole('button', { name: /Edit/ })).toHaveCount(0);
	await page.getByRole('button', { name: `Edit ${templateName}` }).click();
	const nestedTemplateEditor = page.getByRole('dialog', { name: 'Template editor' });
	await expect(nestedTemplateEditor).toBeVisible();
	await expect(nestedTemplateEditor.getByRole('button', { name: 'Delete Template' })).toHaveCount(0);
	const quickTemplateName = `${templateName} Quick Edit`;
	await nestedTemplateEditor.getByLabel('Template name').fill(quickTemplateName);
	await nestedTemplateEditor.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(nestedTemplateEditor).toBeHidden();
	templateName = quickTemplateName;
	await expect(conditionalLayer).toContainText(templateName);
	await expect(page.locator('.channel-schedule-save-state')).toContainText('Unsaved changes');
	await page.locator('.schedule-layer.base').click();
	await expect(page.locator('.base-inspector')).toBeVisible();
	const channelFiller = page.getByRole('group', { name: 'Channel fallback filler' });
	await expect(channelFiller.getByLabel('Configure channel filler')).toBeVisible();
	await channelFiller.getByLabel('Configure channel filler').check();
	await expect(channelFiller.getByLabel('Program')).toBeVisible();
	await expect(channelFiller.getByLabel('Selection policy')).toBeVisible();
	await channelFiller.getByLabel('Configure channel filler').uncheck();
	await page.locator('.schedule-layer.conditional').click();
	await page
		.locator('.schedule-layer-inspector')
		.getByText('Show this layer when', { exact: true })
		.scrollIntoViewIfNeeded();
	const predicateType = page.locator('.schedule-layer-inspector').getByLabel('Predicate type').last();
	await predicateType.selectOption('time-range');
	await expect(conditionalLayer.locator('.schedule-layer-copy small')).toHaveText(
		'12–5 PM timeslot',
	);
	await expectControlHeight(page.locator('.predicate-time-range').getByLabel('Starts'), 42);
	await expectControlHeight(page.locator('.predicate-time-range').getByLabel('Ends'), 42);
	await predicateType.selectOption('date-range');
	await expectControlHeight(page.locator('.predicate-date-range').getByLabel('Starts'), 42);
	await expectControlHeight(page.locator('.predicate-date-range').getByLabel('Ends'), 42);
	await predicateType.selectOption('weekdays');
	await expect(conditionalLayer.locator('.schedule-layer-copy small')).toHaveText('weekdays');
	const entryBoundary = page.getByRole('group', { name: 'Entry boundary' });
	await expect(entryBoundary).toContainText('When this layer starts');
	await expect(entryBoundary).toContainText('lower-priority programming');
	await entryBoundary.getByLabel('Boundary behavior').selectOption('finish-left');
	await expect(entryBoundary.getByLabel('Maximum drift past boundary (minutes)')).toBeVisible();
	await entryBoundary.getByLabel('Maximum drift past boundary (minutes)').fill('90');
	await entryBoundary
		.getByLabel('If the next outgoing item cannot satisfy this boundary')
		.selectOption('favor-right');
	await entryBoundary.getByLabel('Maximum early start (minutes)').fill('75');
	await entryBoundary.getByLabel('No limit — always finish outgoing item').check();
	await expect(entryBoundary.getByLabel('Maximum drift past boundary (minutes)')).toBeDisabled();
	await expect(
		entryBoundary.getByLabel('If the next outgoing item cannot satisfy this boundary'),
	).toBeDisabled();
	await expect(entryBoundary.getByLabel('Maximum early start (minutes)')).toHaveCount(0);
	await page.route('**/api/v1/channel-schedule-preview', async (route) => {
		const response = await route.fetch();
		const body = (await response.json()) as Record<string, unknown>;
		const segments = body.segments as Array<Record<string, unknown>>;
		const sourceSegment = segments[0]!;
		const sourceStart = Date.parse(String(sourceSegment.start));
		const gap12Start = new Date(sourceStart + 60 * 60 * 1_000).toISOString();
		const gap12Finish = new Date(Date.parse(gap12Start) + 12_000).toISOString();
		const gap8Start = new Date(sourceStart + 2 * 60 * 60 * 1_000).toISOString();
		const gap8Finish = new Date(Date.parse(gap8Start) + 8 * 60 * 1_000).toISOString();
		const gap12 = {
			...sourceSegment,
			id: 'e2e-dead-air-12',
			role: 'dead-air',
			programId: null,
			mediaItemId: null,
			title: 'Dead air',
			playbackPath: null,
			playbackParts: [],
			start: gap12Start,
			finish: gap12Finish,
		};
		const gap8 = {
			...gap12,
			id: 'e2e-dead-air-8-minutes',
			start: gap8Start,
			finish: gap8Finish,
		};
		body.segments = [
			...segments.filter((segment) => segment.role !== 'dead-air'),
			gap12,
			gap8,
		];
		body.issues = [
			{
				code: 'boundary-start-rejected',
				message: 'Boundary preview diagnostic',
				scheduleLayerId: sourceSegment.scheduleLayerId,
				templateId: sourceSegment.templateId,
				slotId: sourceSegment.slotId,
				programId: null,
				mediaItemId: null,
				occurrenceCount: 1,
				occurrences: [{
					start: gap12Start,
					finish: gap12Finish,
					boundaryOrigin: 'template',
				}],
			},
		];
		await route.fulfill({ response, json: body });
	});
	const refreshedLayerPreview = page.waitForResponse(
		(response) =>
			response.request().method() === 'POST'
			&& response.url().endsWith('/api/v1/channel-schedule-preview'),
	);
	await expectControlHeight(page.getByLabel('Preview date'), 42);
	await page.getByRole('button', { name: 'Refresh Now' }).click();
	await refreshedLayerPreview;
	await expect(page.getByLabel('Schedule preview issues')).toContainText(
		'Boundary preview diagnostic',
	);
	await expect(page.getByText('Dead air detected', { exact: true })).toBeVisible();
	await expect(page.locator('.dead-air-diagnostics')).toContainText('2 gaps · 8m 12s total');
	const tinyGapMarker = page.getByRole('button', { name: /Dead air at .* for 12 seconds/ });
	await expect(tinyGapMarker).toBeVisible();
	await expect(page.locator('.dead-air-marker')).toHaveCount(2);
	await tinyGapMarker.focus();
	await page.keyboard.press('Enter');
	await expect(page.locator('#dead-air-diagnostic-e2e-dead-air-12')).toBeFocused();
	await expect(page.locator('.schedule-preview-ruler > span')).toHaveCount(9);
	await expect(page.locator('.schedule-preview-ruler > span').first()).toHaveText('00:00');
	await expect(page.locator('.schedule-preview-ruler > span').last()).toHaveText('24:00');
	await expect(page.getByLabel('Schedule preview legend')).toBeVisible();
	await page.unroute('**/api/v1/channel-schedule-preview');
	await page.route('**/api/v1/scheduling/materializations', async (route) => {
		const response = await route.fetch();
		const body = (await response.json()) as Array<Record<string, unknown>>;
		for (const status of body) {
			status.health = 'pending';
			status.applyAfter = new Date(Date.now() + 60_000).toISOString();
		}
		await route.fulfill({ response, json: body });
	});
	await page.route('**/api/v1/scheduling/overview', async (route) => {
		await route.fulfill({
			status: 503,
			contentType: 'application/json',
			body: JSON.stringify({
				code: 'overview_unavailable',
				message: 'Scheduling overview could not be refreshed.',
				requestId: 'e2e-overview-refresh-failure',
			}),
		});
	});
	const savedScheduleUrl = page.url();
	await page.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(page).toHaveURL(/\/schedules\/channels$/);
	await expect(page.getByRole('dialog', { name: 'Channel schedule editor', exact: true })).toBeHidden();
	await page.unroute('**/api/v1/scheduling/overview');
	await page.goto(savedScheduleUrl);
	await expect(page.getByText('All changes saved', { exact: true })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
	await expect(page.getByRole('button', { name: 'Reset', exact: true })).toBeDisabled();
	await page.getByRole('button', { name: 'Delete Channel Schedule' }).click();
	const deleteScheduleDialog = page.getByRole('alertdialog', {
		name: 'Delete Channel Schedule?',
	});
	await expect(deleteScheduleDialog).toBeVisible();
	await deleteScheduleDialog.getByRole('button', { name: 'Cancel' }).click();
	await expect(page.getByRole('button', { name: 'Apply After Current Item' })).toBeEnabled();
	await page.unroute('**/api/v1/scheduling/overview');
	await page.unroute('**/api/v1/scheduling/materializations');
	await page.reload();
	await expect(
		page
			.getByRole('group', { name: 'Entry boundary' })
			.getByLabel('No limit — always finish outgoing item'),
	).toBeChecked();
	await page.goto('/schedules/channels');
	const configuredScheduleCard = page
		.locator('.schedule-channel-card')
		.filter({ hasText: `${channelName} Preserved` });
	await expect(configuredScheduleCard.locator('.schedule-channel-stack-summary')).toContainText(
		templateName,
	);
	await expect(configuredScheduleCard.locator('.schedule-channel-stack-summary')).toContainText(
		'Conditional',
	);
	await expect(configuredScheduleCard.locator('.schedule-channel-stack-summary')).toContainText(
		'Base',
	);
	const editSchedule = configuredScheduleCard.getByRole('link', { name: 'Edit schedule' });
	await expect(editSchedule).toBeVisible();
	await expectControlHeight(editSchedule, 42);
	const warningMessages = [
		'Missing media reference',
		'Temporarily unavailable item',
		'Temporarily unavailable item',
		'Boundary could not be satisfied',
		'Program has no playable media',
	];
	await page.route('**/api/v1/schedule-guide?*', async (route) => {
		const response = await route.fetch();
		const body = (await response.json()) as {
			channels: Array<{
				channelId: string;
				preview: { issues: Array<Record<string, unknown>> };
			}>;
		};
		for (const channelPreview of body.channels) {
			channelPreview.preview.issues = warningMessages.map((message, index) => ({
				code: `e2e-warning-${index}`,
				message,
				scheduleLayerId: null,
				templateId: null,
				slotId: null,
				programId: null,
				mediaItemId: null,
				occurrenceCount: 1,
				occurrences: [{
					start: new Date().toISOString(),
					finish: new Date(Date.now() + 12_000).toISOString(),
					boundaryOrigin: 'template',
				}],
			}));
		}
		await route.fulfill({ response, json: body });
	});
	await page.goto('/channels');
	const channelGuideCell = page
		.locator('.guide-channel-cell')
		.filter({ hasText: `${channelName} Preserved` });
	await expect(channelGuideCell.locator('.guide-channel-copy > p')).toContainText('1920×1080');
	await expect(channelGuideCell.locator('.channel-schedule-summary')).toContainText(templateName);
	await expect(channelGuideCell.locator('.channel-schedule-summary')).toHaveCSS(
		'-webkit-line-clamp',
		'2',
	);
	const warningBadge = channelGuideCell.getByRole('button', {
		name: '5 warnings; show details',
	});
	await warningBadge.hover();
	const warningTooltip = page.getByRole('dialog', { name: 'Scheduling warnings' });
	await expect(warningTooltip).toContainText(warningMessages[0]!);
	await expect(warningTooltip).toContainText(warningMessages[1]!);
	await expect(warningTooltip).toContainText(warningMessages[3]!);
	await expect(warningTooltip).not.toContainText(warningMessages[4]!);
	await expect(warningTooltip).toContainText('1 additional warning type');
	await expect(warningTooltip.getByRole('link', { name: 'Diagnose schedule' })).toHaveAttribute(
		'href',
		/\/schedules\/channels\/[0-9a-f-]+\?previewDate=/,
	);
	const warningTooltipBox = await warningTooltip.boundingBox();
	expect(warningTooltipBox).not.toBeNull();
	expect(warningTooltipBox!.x).toBeGreaterThanOrEqual(0);
	expect(warningTooltipBox!.y).toBeGreaterThanOrEqual(0);
	expect(warningTooltipBox!.x + warningTooltipBox!.width).toBeLessThanOrEqual(
		page.viewportSize()!.width,
	);
	expect(warningTooltipBox!.y + warningTooltipBox!.height).toBeLessThanOrEqual(
		page.viewportSize()!.height,
	);
	// Hover may cross into the action without first pinning the warning panel.
	const diagnoseLink = warningTooltip.getByRole('link', { name: 'Diagnose schedule' });
	await diagnoseLink.hover();
	await expect(warningTooltip).toBeVisible();
	await page.locator('.guide-toolbar').hover();
	await expect(warningTooltip).toBeHidden();
	await warningBadge.focus();
	await expect(warningTooltip).toBeVisible();
	await page.keyboard.press('Tab');
	await expect(diagnoseLink).toBeFocused();
	await page.keyboard.press('Shift+Tab');
	await expect(warningBadge).toBeFocused();
	await page.keyboard.press('Tab');
	await page.keyboard.press('Escape');
	await expect(warningTooltip).toBeHidden();
	await expect(warningBadge).toBeFocused();
	await page.locator('.guide-toolbar').click();
	await warningBadge.focus();
	await expect(warningTooltip).toBeVisible();
	await warningBadge.click();
	await page.locator('.guide-toolbar').click();
	await expect(warningTooltip).toBeHidden();
	await warningBadge.click();
	await warningTooltip.getByRole('link', { name: 'Diagnose schedule' }).click();
	await expect(page).toHaveURL(/\/schedules\/channels\/[0-9a-f-]+\?previewDate=/);
	await expect(page.getByRole('dialog', { name: 'Channel schedule editor' })).toBeVisible();
	await page.goto('/guide');
	const guideChannelCell = page
		.locator('.guide-channel-cell')
		.filter({ hasText: `${channelName} Preserved` });
	await expect(guideChannelCell.locator('.guide-channel-copy > p')).toHaveCount(0);
	await expect(guideChannelCell.getByRole('button', { name: '5 warnings; show details' }))
		.toBeVisible();
	await page.unrouteAll({ behavior: 'wait' });
	await page.goto('/schedules/templates?sort=name&view=grid');
	await expect(page).not.toHaveURL(/(?:sort|view)=/);
	const templateHelpHeading = page.getByRole('heading', { name: 'What is a template?' });
	await expect(templateHelpHeading).toBeHidden();
	await page.getByRole('button', { name: 'Help with Templates' }).click();
	await expect(templateHelpHeading).toBeVisible();
	await expect(page.getByRole('dialog').getByRole('heading', { name: 'Templates', exact: true })).toBeVisible();
	await page.getByRole('button', { name: 'Close help' }).click();
	await expect(page.getByLabel('Sort templates')).toHaveCount(0);
	await expect(page.getByRole('group', { name: 'Template view' })).toHaveCount(0);
	const templateSearchControl = page.locator('.template-search-control');
	const templateSearchIconBounds = await templateSearchControl.locator('svg').boundingBox();
	const templateSearchInputBounds = await templateSearchControl.locator('input').boundingBox();
	const templateSearchIconCenter
		= (templateSearchIconBounds?.y ?? 0) + (templateSearchIconBounds?.height ?? 0) / 2;
	const templateSearchInputCenter
		= (templateSearchInputBounds?.y ?? 0) + (templateSearchInputBounds?.height ?? 0) / 2;
	expect(Math.abs(templateSearchIconCenter - templateSearchInputCenter)).toBeLessThan(2);
	const templateRow = page.locator('.template-row').filter({ hasText: templateName });
	await expect(templateRow).toContainText(`${channelName} Preserved`);
	await expect(templateRow).toContainText('2 slots');
	const templateEditAction = templateRow.getByRole('link', { name: `Edit ${templateName}` });
	await expect(templateEditAction).toBeVisible();
	await templateEditAction.hover();
	await expect.poll(() => templateEditAction.evaluate((element) =>
		getComputedStyle(element).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
	const miniSegments = templateRow.locator('.template-mini-track > span');
	await expect(miniSegments).toHaveCount(2);
	expect(
		await miniSegments
			.first()
			.evaluate((element) => getComputedStyle(element).getPropertyValue('--program-color').trim()),
	).toBe(editorColor);
	expect(
		await miniSegments
			.nth(1)
			.evaluate((element) => getComputedStyle(element).getPropertyValue('--program-color').trim()),
	).toBe(editorColor);
	await templateRow.locator('.template-row-duration').click();
	await expect(page.getByRole('dialog', { name: 'Template editor' })).toBeVisible();
	await page.getByRole('button', { name: 'Close template editor' }).click();
	await expect(templateRow).toBeVisible();
	await page.getByRole('searchbox', { name: 'Search templates' }).fill(templateName);
	await expect(page).toHaveURL(/q=E2E(?:\+|%20)Daily/);
	await expect(templateRow).toBeVisible();
	await page.getByRole('searchbox', { name: 'Search templates' }).fill('No matching template');
	await expect(page.getByRole('heading', { name: 'No matching templates' })).toBeVisible();
	await page.getByRole('button', { name: 'Clear Filters' }).click();
	await expect(templateRow).toBeVisible();
});

test('retains only the fallback draft when a channel fallback upload fails', async ({ page }) => {
	const csrfToken = await authenticateAdministrator(page);
	const runId = String(Date.now());
	const originalName = `Partial fallback ${runId}`;
	const savedName = `${originalName} saved`;
	const createdResponse = await page.request.post('/api/v1/channels', {
		headers: { 'x-moirai-csrf': csrfToken },
		data: { number: runId.slice(-8), name: originalName },
	});
	expect(createdResponse.ok()).toBe(true);
	const created = await createdResponse.json() as { id: string };

	await page.goto('/channels');
	await page.getByRole('button', { name: `Edit ${originalName}` }).click();
	await page.getByLabel('Name').fill(savedName);
	await page.locator('.fallback-filler-editor input[type="file"]').setInputFiles({
		name: 'retry-fallback.mp4',
		mimeType: 'video/mp4',
		buffer: Buffer.from('fallback-video-fixture'),
	});
	await page.route(`**/api/v1/channels/${created.id}/fallback-filler`, async (route) => {
		if (route.request().method() === 'PUT') {
			await route.fulfill({
				status: 422,
				json: { code: 'validation_error', message: 'Fallback upload failed' },
			});
			return;
		}
		await route.continue();
	});

	await page.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(page.getByText(/Channel changes were saved, but the fallback filler was not/))
		.toBeVisible();
	await expect(page.getByLabel('Name')).toHaveValue(savedName);
	await expect(page.locator('.fallback-filler-editor')).toContainText('retry-fallback.mp4');
	await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
	// Save becomes available only after the post-failure guide refresh has settled.
	await expect(page.getByText(/Channel changes were saved, but the fallback filler was not/)).toBeVisible();
	await page.unroute(`**/api/v1/channels/${created.id}/fallback-filler`);

	await page.getByRole('button', { name: 'Close channel editor' }).click();
	await page.getByRole('button', { name: 'Discard Changes' }).click();
	await expect(page.getByText(savedName)).toBeVisible();
	await page.getByRole('button', { name: `Edit ${savedName}` }).click();
	await expect(page.getByLabel('Name')).toHaveValue(savedName);
	await expect(page.locator('.fallback-filler-editor')).not.toContainText('retry-fallback.mp4');
});

test('keeps the latest channel fallback response when editors change quickly', async ({ page }) => {
	const csrfToken = await authenticateAdministrator(page);
	const runId = String(Date.now());
	const createChannel = async (suffix: string) => {
		const response = await page.request.post('/api/v1/channels', {
			headers: { 'x-moirai-csrf': csrfToken },
			data: { number: `${runId.slice(-6)}${suffix}`, name: `Fallback race ${suffix} ${runId}` },
		});
		expect(response.ok()).toBe(true);
		return response.json() as Promise<{ id: string; name: string }>;
	};
	const [first, second] = await Promise.all([createChannel('A'), createChannel('B')]);
	let releaseFirst: (() => void) | undefined;
	const firstGate = new Promise<void>((resolve) => {
		releaseFirst = resolve;
	});
	const asset = (filename: string) => ({
		source: 'channel',
		filename,
		contentType: 'video/mp4',
		fileSizeBytes: 1024,
		durationMilliseconds: 60_000,
		resolution: { width: 640, height: 360 },
		hasAudio: true,
		updatedAt: '2026-09-03T12:00:00Z',
		previewUrl: '/api/v1/playback/fallback-filler/preview',
	});
	await page.route('**/api/v1/channels/*/fallback-filler', async (route) => {
		const requestedFirst = route.request().url().includes(first.id);
		if (requestedFirst) {
			await firstGate;
		}
		const current = asset(requestedFirst ? 'first-fallback.mp4' : 'second-fallback.mp4');
		await route.fulfill({
			json: {
				override: current,
				overrideConfigured: true,
				effective: current,
				inherited: { ...current, source: 'bundled', filename: 'dead-air.mp4' },
				overrideError: null,
			},
		});
	});

	await page.goto('/channels');
	await page.getByRole('button', { name: `Edit ${first.name}` }).click();
	await page.getByRole('button', { name: 'Close channel editor' }).click();
	await page.getByRole('button', { name: `Edit ${second.name}` }).click();
	await expect(page.locator('.fallback-filler-editor')).toContainText('second-fallback.mp4');
	releaseFirst?.();
	await expect(page.locator('.fallback-filler-editor')).not.toContainText('first-fallback.mp4');
	await expect(page.locator('.fallback-filler-editor')).toContainText('second-fallback.mp4');
});

test('keeps the latest global fallback response when startup refreshes overlap', async ({ page }) => {
	const csrfToken = await authenticateAdministrator(page);
	let requestCount = 0;
	let releaseFirst: (() => void) | undefined;
	const firstGate = new Promise<void>((resolve) => {
		releaseFirst = resolve;
	});
	const readyEvent = new Promise<void>((resolve) => {
		page.on('websocket', (socket) => {
			socket.on('framereceived', (event) => {
				if (typeof event.payload === 'string' && event.payload.includes('system.ready')) {
					resolve();
				}
			});
		});
	});
	const asset = (filename: string) => ({
		source: 'global',
		filename,
		contentType: 'video/mp4',
		fileSizeBytes: 1024,
		durationMilliseconds: 60_000,
		resolution: { width: 640, height: 360 },
		hasAudio: true,
		updatedAt: '2026-09-03T12:00:00Z',
		previewUrl: '/api/v1/playback/fallback-filler/preview',
	});
	await page.route('**/api/v1/playback/fallback-filler', async (route) => {
		if (route.request().method() !== 'GET') {
			await route.continue();
			return;
		}

		requestCount += 1;
		const current = asset(requestCount === 1 ? 'stale-fallback.mp4' : 'latest-fallback.mp4');
		if (requestCount === 1) {
			await firstGate;
		}
		await route.fulfill({
			json: {
				override: current,
				overrideConfigured: true,
				effective: current,
				inherited: { ...current, source: 'bundled', filename: 'dead-air.mp4' },
				overrideError: null,
			},
		});
	});

	await page.goto('/settings');
	await expect.poll(() => requestCount).toBeGreaterThanOrEqual(1);
	await readyEvent;
	const removed = await page.request.delete('/api/v1/playback/fallback-filler', {
		headers: { 'x-moirai-csrf': csrfToken },
	});
	expect(removed.ok()).toBe(true);
	await expect.poll(() => requestCount).toBeGreaterThanOrEqual(2);
	await expect(page.locator('.fallback-filler-panel')).toContainText('latest-fallback.mp4');
	releaseFirst?.();
	await expect(page.locator('.fallback-filler-panel')).not.toContainText('stale-fallback.mp4');
	await expect(page.locator('.fallback-filler-panel')).toContainText('latest-fallback.mp4');
});

test('removes a configured channel fallback whose asset is unavailable', async ({ page }) => {
	const csrfToken = await authenticateAdministrator(page);
	const runId = String(Date.now());
	const channelName = `Damaged fallback ${runId}`;
	const createdResponse = await page.request.post('/api/v1/channels', {
		headers: { 'x-moirai-csrf': csrfToken },
		data: { number: runId.slice(-8), name: channelName },
	});
	expect(createdResponse.ok()).toBe(true);
	const channel = await createdResponse.json() as { id: string };
	const bundled = {
		source: 'bundled',
		filename: 'dead-air.mp4',
		contentType: 'video/mp4',
		fileSizeBytes: 1024,
		durationMilliseconds: 60_000,
		resolution: { width: 640, height: 360 },
		hasAudio: true,
		updatedAt: null,
		previewUrl: '/api/v1/playback/fallback-filler/preview',
	};
	let removed = false;
	await page.route(`**/api/v1/channels/${channel.id}/fallback-filler`, async (route) => {
		if (route.request().method() === 'DELETE') {
			removed = true;
			await route.fulfill({
				json: {
					override: null,
					overrideConfigured: false,
					effective: bundled,
					inherited: bundled,
					overrideError: null,
				},
			});
			return;
		}
		await route.fulfill({
			json: {
				override: null,
				overrideConfigured: true,
				effective: bundled,
				inherited: bundled,
				overrideError: 'The configured fallback override is unavailable; using an inherited fallback.',
			},
		});
	});

	await page.goto('/channels');
	await page.getByRole('button', { name: `Edit ${channelName}` }).click();
	await page.locator('.channel-fallback-disclosure > button').click();
	const editor = page.locator('.fallback-filler-editor');
	await expect(editor).toContainText('configured fallback override is unavailable');
	await editor.getByRole('button', { name: 'Remove fallback filler override' }).click();
	await editor.getByRole('button', { name: 'Confirm remove fallback filler override' }).click();
	await page.getByRole('button', { name: 'Save', exact: true }).click();
	await expect.poll(() => removed).toBe(true);
});

test('loads playback controls before tracking and independently saving panel drafts', async ({
	page,
}) => {
	await authenticateAdministrator(page);
	let releaseSettings: (() => void) | undefined;
	const settingsGate = new Promise<void>((resolve) => {
		releaseSettings = resolve;
	});
	await page.route('**/api/v1/playback/settings', async (route) => {
		await settingsGate;
		await route.continue();
	});
	let rejectFallbackLoad = true;
	let rejectFallbackSave = false;
	await page.route('**/api/v1/playback/fallback-filler', async (route) => {
		if (route.request().method() === 'GET' && rejectFallbackLoad) {
			await route.fulfill({
				status: 500,
				json: { code: 'load_failed', message: 'Fallback status could not be loaded.' },
			});
			return;
		}
		if (route.request().method() === 'PUT' && rejectFallbackSave) {
			await route.fulfill({
				status: 500,
				json: { code: 'save_failed', message: 'Fallback could not be saved.' },
			});
			return;
		}
		await route.continue();
	});
	await page.goto('/settings');
	const save = page.locator('form').getByRole('button', { name: 'Save Settings' });
	await expect(page.getByRole('status').filter({ hasText: 'Loading playback settings' }))
		.toBeVisible();
	await expect(save).toHaveCount(0);
	releaseSettings?.();
	await expect(save).toBeDisabled();
	await expect(page.locator('.fallback-filler-panel')).toContainText(
		'Fallback status could not be loaded.',
	);
	const disabledSaveOpacity = Number(await save.evaluate((element) =>
		getComputedStyle(element).opacity));
	expect(disabledSaveOpacity).toBeLessThan(0.6);
	await page.unroute('**/api/v1/playback/settings');

	const maximumSessions = page.getByLabel('Maximum active channel sessions');
	const viewingEnabled = page.getByLabel(
		'Learn from channel viewing and apply it to Weighted Random programs',
	);
	const preferencePanel = page.locator('.viewing-preferences-panel');
	const savePreferences = preferencePanel.getByRole('button', { name: 'Save Settings' });
	const originalMaximum = Number(await maximumSessions.inputValue());
	const originalViewingEnabled = await viewingEnabled.isChecked();
	const updatedMaximum = originalMaximum === 32 ? 31 : originalMaximum + 1;
	await expect(savePreferences).toBeDisabled();
	await maximumSessions.fill(String(updatedMaximum));
	await expect(save).toBeEnabled();
	await expect.poll(() => save.evaluate((element) =>
		Number(getComputedStyle(element).opacity))).toBeGreaterThan(disabledSaveOpacity);
	await maximumSessions.fill(String(originalMaximum));
	await expect(save).toBeDisabled();
	await maximumSessions.fill(String(updatedMaximum));
	await viewingEnabled.setChecked(!originalViewingEnabled);
	await expect(save).toBeEnabled();
	await expect(savePreferences).toBeEnabled();

	const settingsUpdates: Array<Record<string, unknown>> = [];
	let rejectNextUpdate = false;
	await page.route('**/api/v1/playback/settings', async (route) => {
		if (route.request().method() !== 'PUT') {
			await route.continue();
			return;
		}

		const payload = route.request().postDataJSON() as Record<string, unknown>;
		settingsUpdates.push(payload);
		if (rejectNextUpdate) {
			rejectNextUpdate = false;
			await route.fulfill({
				status: 500,
				contentType: 'application/json',
				body: JSON.stringify({
					code: 'save_failed',
					message: 'Settings could not be saved.',
					requestId: 'e2e-settings-failure',
				}),
			});
			return;
		}

		await route.fulfill({ json: payload });
	});
	await save.click();
	await expect(save).toBeDisabled();
	expect(await viewingEnabled.isChecked()).toBe(!originalViewingEnabled);
	await expect(savePreferences).toBeEnabled();
	expect(settingsUpdates[0]).toEqual({
		maxActiveSessions: updatedMaximum,
		viewingPreferencesEnabled: originalViewingEnabled,
	});

	rejectNextUpdate = true;
	await savePreferences.click();
	await expect(page.getByText('Settings could not be saved.')).toBeVisible();
	await expect(savePreferences).toBeEnabled();
	await savePreferences.click();
	await expect(savePreferences).toBeDisabled();
	expect(settingsUpdates.at(-1)).toEqual({
		maxActiveSessions: updatedMaximum,
		viewingPreferencesEnabled: !originalViewingEnabled,
	});

	const fallbackPanel = page.locator('.fallback-filler-panel');
	const fallbackInput = fallbackPanel.locator('input[type="file"]');
	const fallbackFixture = {
		name: 'global-fallback.mp4',
		mimeType: 'video/mp4',
		buffer: Buffer.from('global-fallback-fixture'),
	};
	await fallbackInput.setInputFiles(fallbackFixture);
	await expect(fallbackPanel).toContainText('Pending upload');
	await fallbackPanel.getByRole('button', { name: 'Reset fallback draft' }).click();
	await fallbackPanel.getByRole('button', { name: 'Confirm Reset fallback draft' }).click();
	await expect(fallbackInput).toHaveValue('');
	await fallbackInput.setInputFiles(fallbackFixture);
	await expect(fallbackPanel).toContainText('Pending upload');
	rejectFallbackLoad = false;
	rejectFallbackSave = true;
	await fallbackPanel.getByRole('button', { name: 'Save Fallback' }).click();
	await expect(fallbackPanel.getByText('Fallback could not be saved.')).toBeVisible();
	await page.getByRole('button', { name: 'Refresh Status' }).click();
	await expect(fallbackPanel.getByText('Fallback could not be saved.')).toBeVisible();
	rejectFallbackSave = false;
	await fallbackPanel.getByRole('button', { name: 'Save Fallback' }).click();
	await page.unroute('**/api/v1/playback/fallback-filler');
	await expect(fallbackPanel.getByRole('button', { name: 'Save Fallback' })).toBeDisabled({ timeout: 30_000 });
	await expect(fallbackPanel).toContainText('Global override', { timeout: 30_000 });
	await expect(fallbackPanel).toContainText('global-fallback.mp4');
	await fallbackPanel.getByRole('button', { name: 'Remove fallback filler override' }).click();
	await fallbackPanel.getByRole('button', {
		name: 'Confirm remove fallback filler override',
	}).click();
	await expect(fallbackPanel).toContainText('Bundled Moirai fallback after save');
	await expect(fallbackPanel).toContainText('dead-air.mp4');
	await expect(fallbackPanel.locator('video')).toBeVisible();
	await fallbackPanel.getByRole('button', { name: 'Save Fallback' }).click();
	await expect(fallbackPanel).toContainText('Bundled Moirai fallback');

	let viewingHistoryCleared = false;
	await page.route('**/api/v1/viewing-preferences/clear', async (route) => {
		viewingHistoryCleared = true;
		await route.fulfill({ status: 204 });
	});
	await preferencePanel.getByRole('button', { name: 'View Current Scores' }).click();
	const scoresDialog = page.getByRole('dialog', { name: 'Current scores' });
	const clearHistory = scoresDialog.getByRole('button', { name: 'Clear History', exact: true });
	await clearHistory.click();
	await expect(scoresDialog.getByRole('button', { name: 'Confirm Clear History' })).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(clearHistory).toBeVisible();
	expect(viewingHistoryCleared).toBe(false);
	await clearHistory.click();
	await scoresDialog.getByRole('button', { name: 'Confirm Clear History' }).click();
	await expect(page.getByText('Viewing history cleared.')).toBeVisible();
	expect(viewingHistoryCleared).toBe(true);
});

test('enables local credential creation only after its required fields agree', async ({ page }) => {
	const csrfToken = await authenticateAdministrator(page);
	await page.route('**/api/v1/auth/session', async (route) => {
		await route.fulfill({
			json: {
				status: 'authenticated',
				methods: { local: false, logto: true },
				localUsername: null,
				identity: {
					id: '00000000-0000-4000-8000-000000000001',
					provider: 'logto',
					displayName: 'External Administrator',
					username: 'external-admin',
				},
				csrfToken,
			},
		});
	});
	await page.goto('/account');
	const createCredentials = page.getByRole('button', { name: 'Create Local Account' });
	await expect(createCredentials).toBeDisabled();
	await page.getByLabel('Username').fill('fallback-admin');
	await page.getByRole('textbox', { name: /^New password/ })
		.fill('a sufficiently long fallback password');
	await page.getByLabel('Confirm new password').fill('different fallback password');
	await expect(createCredentials).toBeDisabled();
	await page.getByLabel('Confirm new password').fill('a sufficiently long fallback password');
	await expect(createCredentials).toBeEnabled();
	await page.route('**/api/v1/auth/local-credentials', async (route) => {
		expect(route.request().postDataJSON()).toEqual({
			username: 'fallback-admin',
			password: 'a sufficiently long fallback password',
			currentPassword: null,
		});
		await route.fulfill({
			json: {
				status: 'authenticated',
				methods: { local: true, logto: true },
				localUsername: 'fallback-admin',
				identity: {
					id: '00000000-0000-4000-8000-000000000001',
					provider: 'logto',
					displayName: 'External Administrator',
					username: 'external-admin',
				},
				csrfToken,
			},
		});
	});
	await createCredentials.click();
	await expect(page.getByRole('button', { name: 'Update Credentials' })).toBeDisabled();
	await expect(page.getByRole('textbox', { name: /^New password/ })).toHaveValue('');
	await expect(page.getByLabel('Confirm new password')).toHaveValue('');
});

test('uses an accessible navigation drawer on small screens', async ({ page }) => {
	test.setTimeout(60_000);
	await authenticateAdministrator(page);
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto('/');
	const sidebar = page.locator('.sidebar');
	await page.getByRole('button', { name: 'Open navigation' }).click();
	await expect(sidebar).toHaveClass(/sidebar-open/);
	for (const name of ['Toggle schedule navigation', 'Toggle playback navigation']) {
		const toggle = page.getByRole('button', { name });
		if (await toggle.getAttribute('aria-expanded') === 'false') {
			await toggle.click();
		}
	}
	for (const viewport of [{ width: 390, height: 844 }, { width: 844, height: 390 }]) {
		await page.setViewportSize(viewport);
		await expect(sidebar.getByRole('button', { name: 'Sign out' })).toBeInViewport();
		await expect(sidebar.getByRole('link', { name: /Signed in via local/i })).toBeInViewport();
		const templates = sidebar.getByRole('link', { name: 'Credit Templates', exact: true });
		await templates.scrollIntoViewIfNeeded();
		await expect(templates).toBeInViewport();
	}
	await page.setViewportSize({ width: 390, height: 844 });

	await expect(page.getByRole('link', { name: 'Channels', exact: true })).toBeVisible();
	const guideLink = page.getByRole('link', { name: 'Guide', exact: true });
	await expect(guideLink).toBeVisible();
	await guideLink.click();
	await expect(page).toHaveURL(/\/guide$/);
	await expect(page.getByRole('heading', { name: 'Guide', exact: true })).toBeVisible();
	await expect(page.getByLabel('Channel playlist (M3U)')).toHaveValue(/\/iptv\/channels\.m3u$/);
	await expect(page.getByLabel('XMLTV guide')).toHaveValue(/\/epg\.xml$/);
	await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
	const feedCard = page.locator('.epg-feed-card');
	const restingHeight = await feedCard.evaluate((element) => element.getBoundingClientRect().height);
	const playlistUrl = page.locator('.epg-url-field').filter({ hasText: 'Channel playlist' });
	await playlistUrl.getByRole('button', { name: 'Copy URL' }).click();
	await expect(playlistUrl.locator('.epg-copy-status')).toHaveText('Playlist URL copied');
	await expect(playlistUrl.locator('.epg-copy-status')).toHaveClass(/visible/);
	await expect.poll(() => feedCard.evaluate((element) => element.getBoundingClientRect().height))
		.toBe(restingHeight);
	await expect(playlistUrl.locator('.epg-copy-status')).not.toHaveClass(/visible/, { timeout: 3_000 });
	const guideUrl = page.locator('.epg-url-field').filter({ hasText: 'XMLTV guide' });
	await guideUrl.getByRole('button', { name: 'Copy URL' }).click();
	await expect(guideUrl.locator('.epg-copy-status')).toHaveText('EPG URL copied');
	await expect(guideUrl.locator('.epg-copy-status')).toHaveClass(/visible/);
	await page.getByRole('button', { name: 'Open navigation' }).click();
	await page.keyboard.press('Escape');
	await expect(sidebar).not.toHaveClass(/sidebar-open/);
	await page.getByRole('button', { name: 'Open navigation' }).click();
	await page.getByRole('link', { name: /Signed in via local/i }).click();
	await expect(page).toHaveURL(/\/account$/);
	await expect(page.getByRole('heading', { name: 'Account', exact: true })).toBeVisible();
	await expect(page.getByLabel('Username')).toHaveValue(E2E_ADMIN_USERNAME);
	const updateCredentials = page.getByRole('button', { name: 'Update Credentials' });
	await expect(updateCredentials).toBeDisabled();
	await page.getByLabel('Current password').fill(E2E_ADMIN_PASSWORD);
	await page.getByRole('textbox', { name: /^New password/ })
		.fill('another sufficiently long password');
	await page.getByLabel('Confirm new password').fill('passwords do not match');
	await expect(updateCredentials).toBeDisabled();
	await page.getByLabel('Confirm new password').fill('another sufficiently long password');
	await expect(updateCredentials).toBeEnabled();
	await page.getByLabel('Current password').fill('');
	await expect(updateCredentials).toBeDisabled();
});

test('keeps catalog navigation sticky and synchronizes visible anchors with history', async ({
	page,
}) => {
	const csrfToken = await authenticateAdministrator(page);
	const runId = String(Date.now());
	const libraryName = `E2E Anchors ${runId}`;
	const mediaRoot = path.resolve(`test-results/runtime/anchors-${runId}`);
	const titles = [
		...Array.from({ length: 18 }, (_, index) => `Alpha ${String(index + 1).padStart(2, '0')}`),
		...Array.from({ length: 18 }, (_, index) => `Beta ${String(index + 1).padStart(2, '0')}`),
	];
	await mkdir(mediaRoot, { recursive: true });
	await Promise.all(
		titles.flatMap((title) => {
			const stem = title.replace(' ', '-');
			const genre = title.startsWith('Alpha') ? 'Alpha Genre' : 'Beta Genre';
			return [
				writeFile(path.join(mediaRoot, `${stem}.mp4`), 'fixture'),
				writeFile(
					path.join(mediaRoot, `${stem}.nfo`),
					`<movie><title>${title}</title><genre>${genre}</genre></movie>`,
				),
			];
		}),
	);

	const response = await page.request.post('/api/v1/libraries', {
		headers: { 'x-moirai-csrf': csrfToken },
		data: {
			name: libraryName,
			typeKey: 'movies',
			sourceType: 'on-disk',
			sourceConfig: { scanRoot: mediaRoot, playbackRoot: null },
			watcherEnabled: false,
		},
	});
	expect(response.ok()).toBe(true);
	const created = (await response.json()) as { id: string };
	await waitForLibraryScan(page, created.id);
	await expect
		.poll(async () => {
			const library = (await (
				await page.request.get(`/api/v1/libraries/${created.id}`)
			).json()) as { itemCount: number };
			return library.itemCount;
		})
		.toBe(titles.length);

	let mediaRequests = 0;
	page.on('request', (request) => {
		if (request.url().includes(`/api/v1/libraries/${created.id}/media?`)) {
			mediaRequests += 1;
		}
	});
	await page.goto(`/libraries/${created.id}`);
	await expect
		.poll(() => page.locator('.virtual-media-card-grid .media-card').count())
		.toBeLessThan(titles.length);
	const titleA = page.getByRole('button', { name: 'A', exact: true });
	const titleB = page.getByRole('button', { name: 'B', exact: true });
	await expect(titleA).toHaveAttribute('aria-current', 'location');
	await expect(page).toHaveURL(/anchor=A/);
	const requestsAfterLoad = mediaRequests;

	await titleB.click();
	await expect(titleB).toHaveAttribute('aria-current', 'location');
	await expect(page).toHaveURL(/anchor=B/);
	await expect.poll(() => mediaRequests).toBe(requestsAfterLoad);
	await expect
		.poll(async () => {
			const anchor = await page.locator('[data-catalog-anchor="B"]').boundingBox();
			const toolbar = await page.locator('.catalog-toolbar').boundingBox();
			return anchor && toolbar ? Math.abs(anchor.y - (toolbar.y + toolbar.height + 4)) : 100;
		})
		.toBeLessThan(8);

	await page.goBack();
	await expect(titleA).toHaveAttribute('aria-current', 'location');
	await expect(page).toHaveURL(/anchor=A/);

	await page.evaluate(() => window.scrollTo({ top: document.documentElement.scrollHeight }));
	await expect(titleB).toHaveAttribute('aria-current', 'location');
	await expect(page).toHaveURL(/anchor=B/);
	const header = await page.locator('.library-page-header').boundingBox();
	const toolbar = await page.locator('.catalog-toolbar').boundingBox();
	expect(header?.y).toBeCloseTo(0, 0);
	expect(toolbar?.y).toBeCloseTo(header?.height ?? 0, 0);

	await page.getByRole('button', { name: /Sort by: Title/ }).click();
	await page.getByRole('button', { name: 'Genre', exact: true }).click();
	const betaGenre = page.getByRole('button', { name: 'Beta Genre', exact: true });
	await betaGenre.click();
	await expect(betaGenre).toHaveAttribute('aria-current', 'location');
	await expect(page).toHaveURL(/anchor=beta-genre/);
	await expect
		.poll(async () => {
			const anchor = await page.locator('[data-catalog-anchor="beta-genre"]').boundingBox();
			const stickyToolbar = await page.locator('.catalog-toolbar').boundingBox();
			return anchor && stickyToolbar
				? Math.abs(anchor.y - (stickyToolbar.y + stickyToolbar.height + 4))
				: 100;
		})
		.toBeLessThan(8);

	await page.setViewportSize({ width: 390, height: 844 });
	await page.evaluate(() => window.scrollTo({ top: document.documentElement.scrollHeight }));
	await expect
		.poll(async () => {
			const mobileHeader = await page.locator('.mobile-header').boundingBox();
			const libraryHeader = await page.locator('.library-page-header').boundingBox();
			const stickyToolbar = await page.locator('.catalog-toolbar').boundingBox();
			if (!mobileHeader || !libraryHeader || !stickyToolbar) {
				return 100;
			}

			const headerOffset = Math.abs(libraryHeader.y - mobileHeader.height);
			const toolbarOffset = Math.abs(
				stickyToolbar.y - (mobileHeader.height + libraryHeader.height),
			);
			return Math.max(headerOffset, toolbarOffset);
		})
		.toBeLessThan(2);

	await page.setViewportSize({ width: 1280, height: 900 });
	await page.getByRole('button', { name: 'Sign out' }).click();
	await expect(page).toHaveURL(/\/login$/);
	await page.getByLabel('Username').fill(E2E_ADMIN_USERNAME);
	await page.getByLabel('Password').fill(E2E_ADMIN_PASSWORD);
	const signedIn = page.waitForResponse((response) => response.url().endsWith('/api/v1/auth/login'));
	await page.getByRole('button', { name: 'Sign in' }).click();
	expect((await signedIn).ok()).toBe(true);
	await expect(page).toHaveURL(/\/$/);
});
