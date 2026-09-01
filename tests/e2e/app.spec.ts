import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import {
	authenticateAdministrator,
	E2E_ADMIN_PASSWORD,
	E2E_ADMIN_USERNAME,
} from './authentication';

const wideLogoSvg = Buffer.from(
	'<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200"><rect width="400" height="200" fill="#20c997"/></svg>',
);
const posterPng = await readFile(path.resolve('apps/web/src/assets/moirai-logo.png'));

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
		'<movie><title>Broadcast Fixture</title><year>2026</year><plot>A broadcast preview summary.</plot><rating>8.4</rating><genre>Sci-Fi</genre><genre>Drama</genre><director>Jane Director</director><actor><name>Ada Actor</name><role>Host</role><order>1</order></actor><actor><name>Bea Performer</name><order>2</order></actor><actor><name>Cora Player</name><order>3</order></actor><actor><name>Unbilled Player</name></actor></movie>',
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
	await page.getByLabel('Name').fill(libraryName);
	await page.getByLabel('Path Moirai scans').fill(mediaRoot);
	await page.getByRole('button', { name: 'Add and Scan' }).click();

	const libraryRow = page.locator('.library-row').filter({
		has: page.getByRole('link', { name: libraryName, exact: true }),
	});
	await expect(libraryRow).toBeVisible();
	await expect(libraryRow).toContainText('2 indexed');
	const recentMedia = libraryRow.getByRole('link', { name: /Broadcast Fixture/ });
	await expect(recentMedia).toBeVisible();
	await expect(recentMedia).toHaveAttribute('href', /\/items\//);
	await libraryRow.getByRole('link', { name: libraryName, exact: true }).click();
	await expect(page.locator('.library-status-panel')).toContainText('Watcher');
	await expect(page.locator('.status-watcher')).toContainText('ready');
	await expect(page.locator('.library-status-panel')).toContainText('Indexed');
	await expect(page.getByRole('button', { name: 'B', exact: true })).toHaveClass(/active/);
	await expect(page.locator('.catalog-footer')).toContainText('100 per page');
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
	const deleteLibrary = librarySettings.getByRole('button', { name: 'Remove library permanently' });
	await expect(deleteLibrary).toBeHidden();
	const deleteDisclosure = librarySettings.getByText('Permanently remove this library', { exact: true });
	await deleteDisclosure.click();
	await expect(deleteLibrary).toBeVisible();
	await expect(deleteLibrary).toBeDisabled();
	const deleteConfirmation = librarySettings.getByLabel(new RegExp(`Type ${libraryName} to confirm`));
	await deleteConfirmation.fill(libraryName);
	await expect(deleteLibrary).toBeEnabled();
	await deleteDisclosure.click();
	await expect(deleteLibrary).toBeHidden();
	await deleteDisclosure.click();
	await expect(deleteConfirmation).toHaveValue('');
	await expect(deleteLibrary).toBeDisabled();
	await librarySettings.getByRole('button', { name: 'Cancel' }).click();
	const movieLibraryUrl = page.url();

	await page.getByRole('button', { name: /Sort by: Title/ }).click();
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

	await page.getByRole('button', { name: 'Filter' }).click();
	await expect(page.getByRole('heading', { name: 'Filter media' })).toBeVisible();
	await expect(page.getByText('Narrow down your results using the filters below.')).toBeVisible();
	await expect(page.getByRole('radio', { name: /Match all/ })).toBeChecked();
	await page.getByLabel('Actor').fill('Discarded draft');
	await page.getByRole('button', { name: 'Cancel' }).click();
	const initialGenreFacets = waitForGenreFacets([]);
	await page.getByRole('button', { name: 'Filter' }).click();
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
	await page.getByRole('button', { name: 'Apply filters' }).click();
	await expect(page).not.toHaveURL(/actor=/);
	await expect(page).not.toHaveURL(/genre=/);
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
	await expect(page.getByRole('heading', { name: 'Broadcast profile' })).toBeVisible();
	await expect(page.locator('.acceleration-prediction')).toBeVisible();
	await page.getByLabel('Number').fill(runId.slice(-8));
	await page.getByLabel('Name').fill(channelName);
	await page.getByRole('button', { name: 'Save Changes' }).click();
	await expect(page).toHaveURL(/\/channels$/);
	await expect(page.getByText(channelName)).toBeVisible();
	await expect(page.getByLabel('Seven-day channel guide')).toBeVisible();
	await expect(page.locator('.status-nav-link')).toContainText('IPTV service ready');
	await expect(page.locator('.etv-card')).toHaveCount(0);
	await page.getByRole('button', { name: `Edit ${channelName}` }).click();
	await expect(page.getByRole('heading', { name: 'Broadcast profile' })).toBeVisible();
	await expect(page.getByLabel('Name')).toHaveValue(channelName);
	await page.getByLabel('Name').fill(`${channelName} Edited`);
	await page.locator('input[type="file"]').setInputFiles({
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
	await page.getByRole('button', { name: 'Save Changes' }).click();
	await expect(page.getByText(`${channelName} Edited`)).toBeVisible();

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
	await page.getByRole('button', { name: 'Save Changes' }).click();
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

	await page.route('**/api/v1/channels', async (route) => {
		await new Promise((resolve) => setTimeout(resolve, 500));
		await route.continue();
	});
	await page.getByRole('link', { name: 'Library', exact: true }).click();
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
	await expect(programHelpHeading).toBeVisible();
	await page.getByRole('button', { name: 'Dismiss program help' }).click();
	await expect(programHelpHeading).toBeHidden();
	await page.reload();
	await expect(programHelpHeading).toBeHidden();
	await page.getByRole('button', { name: 'Show program help' }).click();
	await expect(programHelpHeading).toBeVisible();

	const programName = `E2E Movie Picks ${runId}`;
	await page.setViewportSize({ width: 768, height: 1024 });
	await page.addStyleTag({ content: '.modal, .modal-backdrop { display: none !important; }' });
	await page.getByRole('link', { name: 'New Program' }).click();
	await expect(page.getByRole('dialog')).toBeVisible();
	await page.setViewportSize({ width: 1440, height: 900 });
	const programTypes = page.getByRole('radiogroup', { name: 'Program type' });
	await expect(programTypes).toBeVisible();
	await expect(page.getByRole('radio', { name: /Content/ })).toBeChecked();
	await expect(
		page.getByLabel('Source type').getByRole('option', { name: /Exact item/ }),
	).toHaveCount(0);
	const programTypeHeading = await page
		.getByRole('heading', { name: 'Program type', exact: true })
		.boundingBox();
	const firstProgramType = await programTypes.locator('label').first().boundingBox();
	expect(Math.abs((programTypeHeading?.x ?? 0) - (firstProgramType?.x ?? 0))).toBeLessThan(2);
	await page.getByLabel('Name').fill(programName);
	await page.getByLabel('Source type').selectOption('collection');
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
	await expect(sourceMovie.getByRole('button', { name: 'Remove' })).toHaveClass(
		/source-selection-button/,
	);
	await expect(page.getByText('1 selected', { exact: true })).toBeVisible();
	const sourcePickerTopAfterSelection = await page
		.locator('.source-picker-list')
		.evaluate((element) => (element as HTMLElement).offsetTop);
	expect(Math.abs(sourcePickerTopAfterSelection - sourcePickerTopBeforeSelection)).toBeLessThan(2);
	await page.getByRole('button', { name: 'Review Selection' }).click();
	const selectionDrawer = page.getByRole('dialog', { name: 'Review selection' });
	await expect(selectionDrawer).toBeVisible();
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
	await expect(page.getByText('0 selected', { exact: true })).toBeVisible();
	await selectionDrawer.getByRole('button', { name: 'Done' }).click();
	await expect(selectionDrawer).toBeHidden();
	await sourceMovie.getByRole('button', { name: 'Add' }).click();
	await page.getByRole('button', { name: 'Review Selection' }).click();
	page.once('dialog', (dialog) => dialog.accept());
	await selectionDrawer.getByRole('button', { name: 'Clear All' }).click();
	await expect(selectionDrawer.getByText('No media selected.')).toBeVisible();
	await selectionDrawer.getByRole('button', { name: 'Done' }).click();
	await sourceMovie.getByRole('button', { name: 'Add' }).click();
	await page.getByRole('button', { name: 'Save and add another' }).click();
	await expect(page.getByLabel('Name')).toHaveValue('');
	await expect(page.getByLabel('Source type')).toHaveValue('library-query');
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
	await page.getByRole('searchbox', { name: 'Search source media' }).fill('Nova');
	await page.getByRole('button', { name: 'Search', exact: true }).click();
	await expect(page.locator('.source-picker-list')).toContainText('Matched Actor · Nova Performer');
	await expect(page.locator('.source-picker-list')).not.toContainText('First Contact');
	await expect(page.locator('.source-picker-list img').first()).toBeVisible();
	const seasonProgramName = `${programName} Selected Seasons`;
	await page.getByLabel('Name').fill(seasonProgramName);
	await page.getByRole('button', { name: 'Save and add another' }).click();
	await expect(page.getByLabel('Name')).toHaveValue('');
	await expect(page.getByLabel('Source type')).toHaveValue('library-query');
	await page.getByLabel('Source type').selectOption('library-query');
	await page.getByLabel('Name').fill(`${programName} Follow-up`);
	await page.locator('.program-editor-actions button[type="submit"]').click();
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
	await seasonProgramCard.getByRole('link', { name: seasonProgramName, exact: true }).click();
	await page.getByRole('button', { name: 'Review Selection' }).click();
	await expect(page.getByRole('dialog', { name: 'Review selection' })).toContainText('Season 1');
	await page.getByRole('button', { name: 'Done' }).click();
	await page.getByRole('button', { name: 'Cancel' }).click();
	await expect(programCard).toContainText(`1 selected from ${libraryName}`);
	await programCard.getByRole('link', { name: programName, exact: true }).click();
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
	await expect(page.getByRole('button', { name: 'Cancel' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Add Selected' })).toBeDisabled();
	await expect(page.locator('.catalog-controls-stack')).toHaveCSS('position', 'sticky');
	await expect(page.getByRole('toolbar', { name: 'Item selection' })).toHaveCSS('background-color', 'rgb(8, 43, 37)');
	await expect(page.locator('.catalog-footer')).toHaveCSS('position', 'sticky');
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
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.getByLabel('Template name').fill(templateName);
	await expect(page.getByLabel('Preview as channel')).toHaveCount(0);
	await expect(page.getByLabel('Preview date')).toHaveCount(0);
	await expect(page.getByText('NOT CURRENTLY IN USE', { exact: true })).toBeVisible();
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
	const nestedProgramEditor = page.getByRole('dialog', { name: 'Edit program' });
	await expect(nestedProgramEditor).toBeVisible();
	await nestedProgramEditor.getByLabel('Name').fill(`${programName} Quick Edit`);
	await nestedProgramEditor.getByRole('button', { name: 'Save Changes' }).click();
	await expect(nestedProgramEditor).toBeHidden();
	await expect(page.getByLabel('Template name')).toHaveValue(unsavedTemplateName);
	await expect(page.getByLabel('Program').first()).toContainText(`${programName} Quick Edit`);
	await page.getByLabel('Template name').fill(templateName);
	await expect(
		page.getByRole('button', { name: 'Toggle advanced scheduling behavior' }),
	).toHaveCount(0);
	await page.locator('.slot-advanced summary').click();
	await expect(page.locator('.slot-advanced')).toHaveAttribute('open', '');
	const templateBoundary = page.getByRole('group', { name: /Outgoing boundary at/ });
	await templateBoundary.getByLabel('Policy').selectOption('finish-left');
	await templateBoundary.getByLabel('No limit — always finish outgoing item').check();
	await expect(templateBoundary.getByLabel('Maximum drift (minutes)')).toBeDisabled();
	await expect(templateBoundary.getByLabel('Fallback')).toBeDisabled();
	await expect(page.getByRole('heading', { name: 'Preview resolved schedule' })).toBeVisible();
	await page.getByRole('button', { name: 'Save Template' }).click();
	await expect(page).toHaveURL(/\/schedules\/templates\/[0-9a-f-]+$/);
	await expect(page.locator('.notice.error')).toHaveCount(0);
	await page.reload();
	await expect(page.getByLabel('Template name')).toHaveValue(templateName);
	await page.locator('.slot-advanced summary').click();
	await expect(
		page
			.getByRole('group', { name: /Outgoing boundary at/ })
			.getByLabel('No limit — always finish outgoing item'),
	).toBeChecked();
	await page.goto('/schedules/channels');
	const channelScheduleHelp = page.getByRole('heading', { name: 'What is a channel schedule?' });
	await expect(channelScheduleHelp).toBeVisible();
	await page.getByRole('button', { name: 'Dismiss channel schedule help' }).click();
	await expect(channelScheduleHelp).toBeHidden();
	await page.reload();
	await expect(channelScheduleHelp).toBeHidden();
	await page.getByRole('button', { name: 'Show channel schedule help' }).click();
	await expect(channelScheduleHelp).toBeVisible();
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
	await page.getByLabel('Base template', { exact: true }).selectOption({ label: templateName });
	await page.getByRole('button', { name: 'Add conditional template' }).click();
	await expect(page.locator('.schedule-layer.conditional')).toHaveCount(1);
	await expect(page.locator('.channel-schedule-save-state')).toContainText('Unsaved changes');
	const conditionalLayer = page.locator('.schedule-layer.conditional');
	await expect(conditionalLayer.getByRole('button', { name: /Edit/ })).toHaveCount(0);
	await page.getByRole('button', { name: `Edit ${templateName}` }).click();
	const nestedTemplateEditor = page.getByRole('dialog', { name: 'Template editor' });
	await expect(nestedTemplateEditor).toBeVisible();
	const quickTemplateName = `${templateName} Quick Edit`;
	await nestedTemplateEditor.getByLabel('Template name').fill(quickTemplateName);
	await nestedTemplateEditor.getByRole('button', { name: 'Save Template' }).click();
	await expect(nestedTemplateEditor).toBeHidden();
	templateName = quickTemplateName;
	await expect(conditionalLayer).toContainText(templateName);
	await expect(page.locator('.channel-schedule-save-state')).toContainText('Unsaved changes');
	await page.locator('.schedule-layer.base').click();
	await expect(page.locator('.base-inspector')).toBeVisible();
	await page.locator('.schedule-layer.conditional').click();
	await page
		.locator('.schedule-layer-inspector')
		.getByText('Show this layer when', { exact: true })
		.scrollIntoViewIfNeeded();
	const entryBoundary = page.getByRole('group', { name: 'Entry boundary' });
	await expect(entryBoundary).toContainText('When this layer starts');
	await expect(entryBoundary).toContainText('lower-priority programming');
	await entryBoundary.getByLabel('Boundary behavior').selectOption('finish-left');
	await expect(entryBoundary.getByLabel('Maximum drift past boundary (minutes)')).toBeVisible();
	await entryBoundary.getByLabel('Maximum drift past boundary (minutes)').fill('90');
	await entryBoundary.getByLabel('No limit — always finish outgoing item').check();
	await expect(entryBoundary.getByLabel('Maximum drift past boundary (minutes)')).toBeDisabled();
	await expect(
		entryBoundary.getByLabel('If the next outgoing item cannot satisfy this boundary'),
	).toBeDisabled();
	await page.route('**/api/v1/channel-schedule-preview', async (route) => {
		const response = await route.fetch();
		const body = (await response.json()) as Record<string, unknown>;
		body.issues = [
			{
				code: 'boundary-start-rejected',
				message: 'Boundary preview diagnostic',
				scheduleLayerId: null,
				templateId: null,
				slotId: null,
				programId: null,
				mediaItemId: null,
			},
		];
		await route.fulfill({ response, json: body });
	});
	const refreshedLayerPreview = page.waitForResponse(
		(response) =>
			response.request().method() === 'POST'
			&& response.url().endsWith('/api/v1/channel-schedule-preview'),
	);
	await page.getByRole('button', { name: 'Refresh Now' }).click();
	await refreshedLayerPreview;
	await expect(page.getByLabel('Schedule preview issues')).toContainText(
		'Boundary preview diagnostic',
	);
	await expect(page.locator('.schedule-preview-ruler > span')).toHaveCount(9);
	await expect(page.locator('.schedule-preview-ruler > span').first()).toHaveText('00:00');
	await expect(page.locator('.schedule-preview-ruler > span').last()).toHaveText('24:00');
	await expect(page.getByLabel('Schedule preview legend')).toBeVisible();
	await page.unroute('**/api/v1/channel-schedule-preview');
	await page.getByRole('button', { name: 'Save Schedule' }).click();
	await expect(page.getByText('All changes saved', { exact: true })).toBeVisible();
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
	await expect(configuredScheduleCard.getByRole('link', { name: 'Edit schedule' })).toBeVisible();
	await page.goto('/schedules/templates?sort=name&view=grid');
	await expect(page).not.toHaveURL(/(?:sort|view)=/);
	const templateHelpHeading = page.getByRole('heading', { name: 'What is a template?' });
	await expect(templateHelpHeading).toBeVisible();
	await page.getByRole('button', { name: 'Dismiss template help' }).click();
	await expect(templateHelpHeading).toBeHidden();
	await page.reload();
	await expect(templateHelpHeading).toBeHidden();
	await page.getByRole('button', { name: 'Show template help' }).click();
	await expect(templateHelpHeading).toBeVisible();
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
	await page.getByRole('searchbox', { name: 'Search templates' }).fill(templateName);
	await expect(page).toHaveURL(/q=E2E(?:\+|%20)Daily/);
	await expect(templateRow).toBeVisible();
	await page.getByRole('searchbox', { name: 'Search templates' }).fill('No matching template');
	await expect(page.getByRole('heading', { name: 'No matching templates' })).toBeVisible();
	await page.getByRole('button', { name: 'Clear Filters' }).click();
	await expect(templateRow).toBeVisible();
});

test('does not expose playback controls before playback settings load', async ({ page }) => {
	await authenticateAdministrator(page);
	let releaseSettings: (() => void) | undefined;
	const settingsGate = new Promise<void>((resolve) => {
		releaseSettings = resolve;
	});
	await page.route('**/api/v1/playback/settings', async (route) => {
		await settingsGate;
		await route.continue();
	});
	await page.goto('/settings');
	const save = page.getByRole('button', { name: 'Save Settings' });
	await expect(page.getByRole('status')).toContainText('Loading playback settings');
	await expect(save).toHaveCount(0);
	releaseSettings?.();
	await expect(save).toBeEnabled();
});

test('uses an accessible navigation drawer on small screens', async ({ page }) => {
	await authenticateAdministrator(page);
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto('/');
	const sidebar = page.locator('.sidebar');
	await page.getByRole('button', { name: 'Open navigation' }).click();
	await expect(sidebar).toHaveClass(/sidebar-open/);
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
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page).toHaveURL(/\/$/);
});
