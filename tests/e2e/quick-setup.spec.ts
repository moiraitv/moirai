import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { channelCreateSchema } from '@moirai/shared';
import { authenticateAdministrator } from './authentication';
import { waitForLibraryScan } from './library-scan';

const quickLogoSvg = Buffer.from(
	'<svg xmlns="http://www.w3.org/2000/svg" width="2000" height="2000"><rect width="2000" height="2000" fill="#7357ff"/></svg>',
);

test('preserves PNG transparency in both full-image and advanced crop preparation', async ({ page }) => {
	await authenticateAdministrator(page);
	await page.goto('/quick');
	const alphaValues = await page.evaluate(async () => {
		const modulePath = '/src/channel-logo-image.ts';
		const { prepareChannelLogo, loadChannelLogoImage, renderChannelLogoPng } = await import(modulePath);
		const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="30" height="10"><rect x="10" width="10" height="10" fill="red" opacity="0.5"/><rect x="20" width="10" height="10" fill="red"/></svg>';
		const file = new File([svg], 'alpha.svg', { type: 'image/svg+xml' });
		const prepared = await prepareChannelLogo(file, 30, 10, 100_000);
		const loaded = await loadChannelLogoImage(file);
		const cropped = await renderChannelLogoPng(loaded.image, { x: 0, y: 0, width: 30, height: 10 }, 30, 10, 100_000);
		const values: number[][] = [];
		for (const blob of [prepared.blob, cropped]) {
			const bitmap = await createImageBitmap(blob);
			const canvas = document.createElement('canvas');
			canvas.width = 30;
			canvas.height = 10;
			const context = canvas.getContext('2d')!;
			context.drawImage(bitmap, 0, 0);
			values.push([5, 15, 25].map((x) => context.getImageData(x, 5, 1, 1).data[3]!));
			bitmap.close();
		}
		URL.revokeObjectURL(prepared.previewUrl);
		URL.revokeObjectURL(loaded.url);
		return values;
	});
	for (const alpha of alphaValues) {
		expect(alpha[0]).toBe(0);
		expect(alpha[1]).toBeGreaterThanOrEqual(127);
		expect(alpha[1]).toBeLessThanOrEqual(128);
		expect(alpha[2]).toBe(255);
	}
});

test('creates a movie channel through Quick Setup while its new library scans', async ({ page }) => {
	test.setTimeout(120_000);
	const csrfToken = await authenticateAdministrator(page);
	const runId = String(Date.now());
	const mediaRoot = path.resolve(`test-results/runtime/quick-media-${runId}`);
	await rm(mediaRoot, { recursive: true, force: true });
	await mkdir(mediaRoot, { recursive: true });
	await Promise.all(Array.from({ length: 26 }, (_, index) => writeFile(
		path.join(mediaRoot, `Quick Movie ${String(index).padStart(2, '0')}.mp4`),
		'fixture',
	)));

	await page.goto('/quick');
	const setupDialog = page.getByRole('dialog', { name: 'Quick Setup', exact: true });
	await expect(setupDialog).toHaveCount(0);
	await expect(page.getByRole('heading', { name: 'What would you like to make?' })).toBeVisible();
	await page.getByRole('button', { name: /Movie Channel/ }).click();
	await expect(setupDialog).toBeVisible();
	await expect(setupDialog.getByRole('heading', { name: 'Choose a media library' })).toBeVisible();
	await page.getByRole('button', { name: 'Create new' }).click();
	await page.getByLabel('Name').fill(`Quick Movies ${runId}`);
	await page.getByLabel('Path Moirai scans').fill(mediaRoot);
	await page.getByRole('button', { name: 'Create and Continue' }).click();

	await expect(page.getByRole('heading', { name: 'Choose the programming' })).toBeVisible();
	await page.locator('#quick-setup-actions').getByRole('button', { name: 'Back', exact: true }).click();
	await expect(page.getByRole('combobox', { name: /^Library/ }).locator('option:checked')).toContainText(`Quick Movies ${runId}`);
	await page.locator('#quick-setup-actions').getByRole('button', { name: 'Continue', exact: true }).click();
	await expect(page.getByRole('heading', { name: 'Choose the programming' })).toBeVisible();
	await page.setViewportSize({ width: 390, height: 844 });
	await expect(page.locator('#quick-setup-actions').getByRole('button', { name: 'Continue' })).toBeInViewport();
	await page.locator('.quick-setup-scroll').evaluate((element) => {
		element.scrollTop = element.scrollHeight;
	});
	await expect(page.getByRole('button', { name: 'Close Quick Setup' })).toBeInViewport();
	await expect(page.locator('#quick-setup-actions').getByRole('button', { name: 'Continue' })).toBeInViewport();
	await page.setViewportSize({ width: 1440, height: 1000 });
	await page.getByRole('button', { name: 'Close Quick Setup' }).focus();
	await page.keyboard.press('Escape');
	const leaveDialog = page.getByRole('alertdialog', { name: 'Leave Quick Setup?' });
	await expect(leaveDialog).toContainText('will remain and continue scanning');
	await leaveDialog.getByRole('button', { name: 'Cancel', exact: true }).click();
	await expect(setupDialog).toBeVisible();
	const queryPreview = page.getByLabel('Currently matching media');
	await expect(queryPreview).toContainText('Matching now');
	await expect(queryPreview).toContainText('Quick Movie 00', { timeout: 30_000 });
	await expect(page.getByText('Query parameters', { exact: true })).toBeVisible();
	await expect(page.getByLabel('Order by')).toHaveValue('name');
	await expect(page.getByLabel('Direction')).toHaveValue('asc');
	await expect(page.getByLabel('Limit')).toHaveValue('');
	const initialQueryCards = queryPreview.locator('.quick-query-carousel-item');
	expect(await initialQueryCards.count()).toBeGreaterThan(1);
	const initialQueryCardGaps = await initialQueryCards
		.evaluateAll((cards) => cards.slice(0, 3).map((card, index, visibleCards) => {
			if (index === 0) {
				return 0;
			}
			const previous = visibleCards[index - 1]!.getBoundingClientRect();
			const current = card.getBoundingClientRect();
			return current.left - previous.right;
		}));
	expect(initialQueryCardGaps.slice(1).every((gap) => Math.abs(gap) < 1)).toBe(true);
	await page.getByRole('button', { name: 'Configure Filters' }).click();
	const filterDialog = page.getByRole('dialog', { name: 'Filter media' });
	await filterDialog.getByLabel('Name').fill('Quick Movie');
	await filterDialog.getByRole('button', { name: 'Apply Filters' }).click();
	await expect(page.getByText('Title: Quick Movie')).toBeVisible();
	const queryCarousel = page.getByLabel('Matching media carousel');
	await queryCarousel.evaluate((element) => {
		element.scrollLeft = element.scrollWidth;
		element.dispatchEvent(new Event('scroll'));
	});
	await expect(queryPreview).toContainText('Quick Movie 25', { timeout: 30_000 });

	// Changing libraries must discard selections owned by the previous library.
	await page.getByRole('combobox', { name: /^Media choice/ }).selectOption('collection');
	await page.locator('.source-picker-list article').filter({ hasText: 'Quick Movie 00' })
		.getByRole('button', { name: 'Add', exact: true }).click();
	await expect(page.locator('.quick-selection-review')).toContainText('Quick Movie 00');
	await page.getByRole('button', { name: 'Remove Quick Movie 00', exact: true }).click();
	await expect(page.locator('.quick-selection-review')).toContainText('Quick Movie 00');
	await page.getByRole('button', { name: 'Confirm remove Quick Movie 00', exact: true }).press('Escape');
	await expect(page.getByRole('button', { name: 'Remove Quick Movie 00', exact: true })).toBeVisible();
	await page.getByRole('button', { name: 'Remove Quick Movie 00', exact: true }).click();
	await page.getByRole('button', { name: 'Confirm remove Quick Movie 00', exact: true }).click();
	await expect(page.locator('.quick-selection-review')).toHaveCount(0);
	await page.locator('.source-picker-list article').filter({ hasText: 'Quick Movie 00' })
		.getByRole('button', { name: 'Add', exact: true }).click();
	await page.locator('#quick-setup-actions').getByRole('button', { name: 'Back', exact: true }).click();
	await page.getByRole('button', { name: 'Create new', exact: true }).click();
	const otherRoot = path.resolve(`test-results/runtime/quick-empty-${runId}`);
	await mkdir(otherRoot, { recursive: true });
	await page.getByLabel('Name', { exact: true }).fill(`Other Movies ${runId}`);
	await page.getByLabel('Path Moirai scans').fill(otherRoot);
	await page.getByRole('button', { name: 'Create and Continue' }).click();
	await expect(page.getByRole('heading', { name: 'Choose the programming' })).toBeVisible();
	await expect(page.locator('.quick-selection-review')).toHaveCount(0);
	await expect(page.locator('#quick-setup-actions').getByRole('button', { name: 'Continue', exact: true }))
		.toBeDisabled();
	await page.locator('#quick-setup-actions').getByRole('button', { name: 'Back', exact: true }).click();
	await page.getByRole('button', { name: 'Existing library', exact: true }).click();
	await page.getByRole('combobox', { name: /^Library/ }).selectOption({ label: `Quick Movies ${runId} · 26 indexed` });
	await page.locator('#quick-setup-actions').getByRole('button', { name: 'Continue', exact: true }).click();
	await page.getByRole('combobox', { name: /^Media choice/ }).selectOption('library-query');
	await page.getByLabel('Program name').fill(`Quick Program ${runId}`);
	await page.locator('.quick-step-actions').getByRole('button', { name: 'Continue' }).click();
	await expect(page.getByRole('heading', { name: 'Name and brand the channel' })).toBeVisible();
	await page.getByLabel('Channel number').fill(`quick-${runId}`);
	await page.getByLabel('Channel name').fill(`Quick Channel ${runId}`);
	await page.locator('input[type="file"][accept="image/*"]').setInputFiles({
		name: 'quick-logo.svg',
		mimeType: 'image/svg+xml',
		buffer: quickLogoSvg,
	});
	await expect(page.getByRole('img', { name: 'Selected channel logo preview' })).toBeVisible();
	const logoSize = await page.getByRole('img', { name: 'Selected channel logo preview' }).evaluate((image: HTMLImageElement) => ({ width: image.naturalWidth, height: image.naturalHeight }));
	const videoDefaults = channelCreateSchema.shape.video.parse(undefined);
	expect(logoSize.width).toBeLessThanOrEqual(videoDefaults.width!);
	expect(logoSize.height).toBeLessThanOrEqual(videoDefaults.height!);
	expect(logoSize.width).toBe(logoSize.height);
	let previewAttempts = 0;
	let releasePreview!: () => void;
	const previewGate = new Promise<void>((resolve) => {
		releasePreview = resolve;
	});
	await page.route('**/api/v1/quick-channel-setups/preview', async (route) => {
		previewAttempts += 1;
		if (previewAttempts === 1) {
			await route.fulfill({ status: 503, json: { message: 'Preview temporarily busy' } });
			return;
		}
		await previewGate;
		await route.continue();
	});
	await page.getByRole('button', { name: 'Review Setup' }).click();

	await expect(page.getByRole('heading', { name: 'Review the setup' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Create Channel', exact: true })).toBeEnabled();
	await page.getByRole('button', { name: 'Retry Preview', exact: true }).click();
	await expect(page.locator('.quick-review-schedule-slot')).toContainText('Resolving');
	const loadingHeights = await page.locator('.quick-review-row').evaluateAll((rows) => rows.map((row) => row.getBoundingClientRect().height));
	const resolvedPreview = page.waitForResponse((response) => response.url().endsWith('/api/v1/quick-channel-setups/preview') && response.status() === 200);
	releasePreview();
	await resolvedPreview;
	await expect(page.getByLabel('Library sample', { exact: true })).toContainText('26 indexed');
	await expect(page.getByLabel('Programming sample', { exact: true })).toContainText('Quick Movie');
	await expect(page.getByLabel('Sample resolved schedule', { exact: true })).toBeVisible();
	const loadedHeights = await page.locator('.quick-review-row').evaluateAll((rows) => rows.map((row) => row.getBoundingClientRect().height));
	expect(loadedHeights).toHaveLength(loadingHeights.length);
	for (const [index, height] of loadedHeights.entries()) {
		expect(height).toBeCloseTo(loadingHeights[index]!, 0);
	}
	await expect(page.getByLabel('Time of day', { exact: true })).toContainText('00:00');
	await expect(page.getByLabel('Time of day', { exact: true })).toContainText('12:00');
	await expect(page.getByLabel('Time of day', { exact: true })).toContainText('24:00');
	await expect(page.getByRole('img', { name: 'Channel logo', exact: true })).toBeVisible();
	await expect(page.locator('.quick-review-row')).toHaveCount(4);
	// Measure the reserved schedule container, which keeps preview loading from shifting the row.
	const bottomInsets = await page.locator('.quick-review-row').evaluateAll((rows) => rows.map((row) => {
		const content = row.querySelector('.program-carousel-card, .quick-review-schedule-slot, .quick-review-channel')!;
		const style = getComputedStyle(row);
		return {
			actual: row.getBoundingClientRect().bottom - content.getBoundingClientRect().bottom,
			expected: parseFloat(style.paddingTop) + parseFloat(style.borderBottomWidth),
		};
	}));
	for (const inset of bottomInsets) {
		expect(Math.abs(inset.actual - inset.expected)).toBeLessThanOrEqual(2);
	}
	await page.getByLabel('Sample resolved schedule', { exact: true }).getByRole('button').first().focus();
	await expect(page.locator('.quick-sample-detail')).toBeVisible();
	await page.setViewportSize({ width: 390, height: 844 });
	expect(await page.locator('.quick-review-grid').evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
	await page.setViewportSize({ width: 1440, height: 1000 });
	const reviewBounds = await setupDialog.boundingBox();
	let releaseLogoRetry!: () => void;
	const logoRetryGate = new Promise<void>((resolve) => {
		releaseLogoRetry = resolve;
	});
	let logoAttempts = 0;
	await page.route('**/api/v1/channels/*/logo', async (route) => {
		logoAttempts += 1;
		if (logoAttempts === 1) {
			await route.fulfill({ status: 500, json: { message: 'Temporary logo failure' } });
			return;
		}
		await logoRetryGate;
		await route.continue();
	});
	const logoUpload = page.waitForResponse((response) =>
		response.url().includes('/api/v1/channels/')
		&& response.url().endsWith('/logo')
		&& response.request().method() === 'PUT');
	const setupResponse = page.waitForResponse((response) =>
		response.url().endsWith('/api/v1/quick-channel-setups')
		&& response.request().method() === 'POST');
	await page.getByRole('button', { name: 'Create Channel' }).click();
	const setup = await (await setupResponse).json();
	expect((await logoUpload).status()).toBe(500);
	await expect(page.getByRole('heading', { name: `quick-${runId} · Quick Channel ${runId}` }))
		.toBeVisible({ timeout: 30_000 });
	await expect(setupDialog).toHaveClass(/quick-setup-complete/);
	await expect.poll(async () => (await setupDialog.boundingBox())!.width).toBeLessThan(reviewBounds!.width);
	expect((await setupDialog.boundingBox())!.height).toBeLessThan(reviewBounds!.height);
	await expect(page.getByRole('link', { name: 'Open Schedule' })).toHaveAttribute(
		'href',
		/\/schedules\/channels\//,
	);
	await page.getByRole('button', { name: 'Retry Logo Upload', exact: true }).click();
	await expect.poll(() => logoAttempts).toBe(2);
	await page.getByRole('button', { name: 'Start Another' }).click();
	await expect(setupDialog).toHaveCount(0);
	await expect(page.getByRole('button', { name: /Movie Channel/ })).toBeFocused();
	await page.getByRole('button', { name: /Show Channel/ }).click();
	await expect(setupDialog.getByRole('heading', { name: 'Choose a media library' })).toBeVisible();
	const retriedLogo = page.waitForResponse((response) => response.url().endsWith('/logo')
		&& response.request().method() === 'PUT');
	releaseLogoRetry();
	expect((await retriedLogo).status()).toBe(200);
	await page.getByRole('button', { name: 'Close Quick Setup' }).click();
	await page.getByRole('button', { name: 'Discard Draft', exact: true }).click();

	// Editing query ordering must not mutate the saved baseline used by Reset.
	await page.goto(`/schedules/programs/${setup.program.id}`);
	await expect(page.getByLabel('Direction')).toBeVisible({ timeout: 30_000 });
	await expect(page.getByLabel('Direction')).toHaveValue('asc');
	await page.getByLabel('Direction').selectOption('desc');
	await page.getByRole('button', { name: 'Reset', exact: true }).click();
	await page.getByRole('button', { name: /Confirm.*Reset|Confirm.*reset/ }).click();
	await expect(page.getByLabel('Direction')).toHaveValue('asc');

	// A completed scan must retain loaded pages and scroll while the refresh is in flight.
	await expect(queryCarousel).toBeVisible();
	await queryCarousel.evaluate((element) => {
		element.scrollLeft = element.scrollWidth;
	});
	await expect(queryPreview).toContainText('Quick Movie 25');
	const scrollLeft = await queryCarousel.evaluate((element) => element.scrollLeft);
	let releaseRefresh!: () => void;
	const refreshGate = new Promise<void>((resolve) => {
		releaseRefresh = resolve;
	});
	let refreshStarted!: () => void;
	const refreshing = new Promise<void>((resolve) => {
		refreshStarted = resolve;
	});
	await page.route('**/api/v1/quick-channel-setups/query-preview', async (route) => {
		refreshStarted();
		await refreshGate;
		await route.continue();
	});
	await writeFile(path.join(mediaRoot, 'Quick Movie 26.mp4'), 'fixture');
	const scan = await page.request.post(`/api/v1/libraries/${setup.program.config.source.libraryId}/scans`, {
		headers: { 'X-Moirai-CSRF': csrfToken },
	});
	expect(scan.ok()).toBe(true);
	await refreshing;
	await expect(queryCarousel).toBeVisible();
	await expect(queryPreview).toContainText('Quick Movie 25');
	expect(await queryCarousel.evaluate((element) => element.scrollLeft)).toBe(scrollLeft);
	releaseRefresh();
	await expect(queryPreview).toContainText('27 indexed');
	await expect(queryPreview).toContainText('Quick Movie 25');
	expect(await queryCarousel.evaluate((element) => element.scrollLeft)).toBe(scrollLeft);
});

test('refreshes Match any genres while Quick Setup remains open during indexing', async ({ page }) => {
	// This workflow completes an initial scan and a second scan after authoring new media.
	test.setTimeout(60_000);
	const csrfToken = await authenticateAdministrator(page);
	const runId = String(Date.now());
	const mediaRoot = path.resolve(`test-results/runtime/quick-genres-${runId}`);
	await mkdir(mediaRoot, { recursive: true });
	await page.goto('/quick');
	await page.getByRole('button', { name: /Movie Channel/ }).click();
	await page.getByRole('button', { name: 'Create new', exact: true }).click();
	await page.getByLabel('Name', { exact: true }).fill(`Genre Movies ${runId}`);
	await page.getByLabel('Path Moirai scans').fill(mediaRoot);
	const created = page.waitForResponse((response) => response.url().endsWith('/api/v1/libraries')
		&& response.request().method() === 'POST');
	await page.getByRole('button', { name: 'Create and Continue' }).click();
	const library = await (await created).json();
	await waitForLibraryScan(page, library.id);
	await expect(page.getByLabel('Currently matching media')).toContainText('No indexed media matches yet.');
	await page.getByRole('button', { name: 'Configure Filters' }).click();
	const filters = page.getByRole('dialog', { name: 'Filter media' });
	await filters.getByRole('radio', { name: /Match any/ }).check();
	await expect(filters.getByRole('button', { name: /Has Drama/ })).toHaveCount(0);
	await writeFile(path.join(mediaRoot, 'New Drama.nfo'), '<movie><title>New Drama</title><genre>Drama</genre></movie>');
	await writeFile(path.join(mediaRoot, 'New Drama.mp4'), 'fixture');
	const scan = await page.request.post(`/api/v1/libraries/${library.id}/scans`, {
		headers: { 'X-Moirai-CSRF': csrfToken },
	});
	expect(scan.ok()).toBe(true);
	const drama = filters.getByRole('button', { name: /Has Drama/ });
	await expect(drama).toBeVisible({ timeout: 30_000 });
	await drama.click();
	await filters.getByRole('button', { name: 'Apply Filters' }).click();
	await expect(page.getByLabel('Currently matching media')).toContainText('New Drama');
});

for (const reducedMotion of ['no-preference', 'reduce'] as const) {
	test(`retains keyboard focus across wizard steps with ${reducedMotion} motion`, async ({ page }) => {
		await authenticateAdministrator(page);
		await page.emulateMedia({ reducedMotion });
		const runId = `${Date.now()}-${reducedMotion}`;
		const mediaRoot = path.resolve(`test-results/runtime/quick-focus-${runId}`);
		await mkdir(mediaRoot, { recursive: true });
		await page.goto('/quick');
		await page.getByRole('button', { name: /Movie Channel/ }).press('Enter');
		const dialog = page.getByRole('dialog', { name: 'Quick Setup', exact: true });
		const actions = page.locator('#quick-setup-actions');
		await page.getByRole('button', { name: 'Create new', exact: true }).click();
		await page.getByLabel('Name', { exact: true }).fill(`Focus Movies ${runId}`);
		await page.getByLabel('Path Moirai scans').fill(mediaRoot);
		await page.getByRole('button', { name: 'Create and Continue' }).press('Enter');
		await expect(page.getByRole('heading', { name: 'Choose the programming' })).toBeFocused();
		await actions.getByRole('button', { name: 'Back', exact: true }).press('Enter');
		await expect(page.getByRole('heading', { name: 'Choose a media library' })).toBeFocused();
		await actions.getByRole('button', { name: 'Continue', exact: true }).press('Enter');
		await expect(page.getByRole('heading', { name: 'Choose the programming' })).toBeFocused();
		const configure = page.getByRole('button', { name: 'Configure Filters', exact: true });
		await configure.press('Enter');
		await page.getByRole('button', { name: 'Apply Filters', exact: true }).press('Enter');
		await expect(configure).toBeFocused();
		await configure.press('Enter');
		await expect(page.getByRole('dialog', { name: 'Filter media' })).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(configure).toBeFocused();
		await page.keyboard.press('Escape');
		const filterExit = page.getByRole('alertdialog', { name: 'Leave Quick Setup?' });
		await expect(filterExit).toBeVisible();
		await filterExit.getByRole('button', { name: 'Cancel', exact: true }).click();
		await expect(filterExit).toHaveCount(0);
		await expect(configure).toBeFocused();
		await actions.getByRole('button', { name: 'Continue', exact: true }).press('Enter');
		await expect(page.getByRole('heading', { name: 'Name and brand the channel' })).toBeFocused();
		await page.getByRole('button', { name: 'Review Setup', exact: true }).press('Enter');
		await expect(page.getByRole('heading', { name: 'Review the setup' })).toBeFocused();
		const warnings = page.locator('.quick-review-schedule-warnings');
		await expect(warnings).toBeVisible();
		await warnings.locator('summary').press('Enter');
		await expect(warnings.getByText(/has no playable media/)).toBeVisible();
		expect(await warnings.evaluate((element) => {
			const panel = element.closest('.quick-review-row')!;
			return element.getBoundingClientRect().bottom <= panel.getBoundingClientRect().bottom;
		})).toBe(true);
		await actions.getByRole('button', { name: 'Back', exact: true }).press('Enter');
		await expect(page.getByRole('heading', { name: 'Name and brand the channel' })).toBeFocused();
		await page.keyboard.press('Tab');
		await expect(page.getByLabel('Channel number')).toBeFocused();
		await page.getByRole('button', { name: 'Review Setup', exact: true }).focus();
		await page.keyboard.press('Tab');
		await expect(dialog.getByRole('button', { name: 'Help with Quick Setup', exact: true })).toBeFocused();
		await page.keyboard.press('Tab');
		await expect(page.getByRole('button', { name: 'Close Quick Setup' })).toBeFocused();
		await page.keyboard.press('Shift+Tab');
		await expect(dialog.getByRole('button', { name: 'Help with Quick Setup', exact: true })).toBeFocused();
		await page.keyboard.press('Shift+Tab');
		await expect(page.getByRole('button', { name: 'Review Setup', exact: true })).toBeFocused();
		await actions.getByRole('button', { name: 'Back', exact: true }).press('Enter');
		await expect(page.getByRole('heading', { name: 'Choose the programming' })).toBeFocused();
		await page.keyboard.press('Escape');
		const confirmation = page.getByRole('alertdialog', { name: 'Leave Quick Setup?' });
		await expect(confirmation).toBeVisible();
		await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
		await expect(dialog).toBeVisible();
	});
}

test('confirms removal of selected shows and seasons in Quick Setup', async ({ page }) => {
	await authenticateAdministrator(page);
	const runId = String(Date.now());
	const mediaRoot = path.resolve(`test-results/runtime/quick-groups-${runId}`);
	const seasonRoot = path.join(mediaRoot, 'Space Station', 'Season 01');
	await mkdir(seasonRoot, { recursive: true });
	await writeFile(path.join(seasonRoot, 'Space Station S01E01.mp4'), 'fixture');
	await page.goto('/quick');
	await page.getByRole('button', { name: /Show Channel/ }).click();
	await page.getByRole('button', { name: 'Create new', exact: true }).click();
	await page.getByLabel('Name', { exact: true }).fill(`Quick Groups ${runId}`);
	await page.getByLabel('Path Moirai scans').fill(mediaRoot);
	await page.getByRole('button', { name: 'Create and Continue' }).click();
	await page.getByRole('combobox', { name: /^Media choice/ }).selectOption('group-collection');
	const show = page.locator('.source-picker-list article').filter({ hasText: 'Space Station' });
	await expect(show).toBeVisible({ timeout: 30_000 });
	await show.getByRole('button', { name: 'Add', exact: true }).click();
	await page.getByRole('button', { name: 'Remove Space Station', exact: true }).click();
	await expect(page.locator('.quick-selected-list')).toContainText('Space Station');
	await page.getByRole('button', { name: 'Confirm remove Space Station', exact: true }).press('Escape');
	await page.getByRole('button', { name: 'Remove Space Station', exact: true }).click();
	await page.getByRole('button', { name: 'Confirm remove Space Station', exact: true }).click();
	await expect(page.locator('.quick-selected-list')).toHaveCount(0);
	await show.getByRole('button', { name: 'Browse', exact: true }).click();
	await page.locator('.source-picker-list article').filter({ hasText: 'Season 1' })
		.getByRole('button', { name: 'Add', exact: true }).click();
	await page.getByRole('button', { name: 'Remove Season 1', exact: true }).click();
	await expect(page.locator('.quick-selected-list')).toContainText('Season 1');
	await page.getByRole('button', { name: 'Confirm remove Season 1', exact: true }).click();
	await expect(page.locator('.quick-selected-list')).toHaveCount(0);
});

test('fits the ready dialog immediately with reduced motion', async ({ page }) => {
	await authenticateAdministrator(page);
	await page.emulateMedia({ reducedMotion: 'reduce' });
	const runId = String(Date.now());
	const mediaRoot = path.resolve(`test-results/runtime/quick-reduced-${runId}`);
	await mkdir(mediaRoot, { recursive: true });
	await page.goto('/quick');
	await page.getByRole('button', { name: /Movie Channel/ }).click();
	await page.getByRole('button', { name: 'Create new', exact: true }).click();
	await page.getByLabel('Name', { exact: true }).fill(`Reduced Movies ${runId}`);
	await page.getByLabel('Path Moirai scans').fill(mediaRoot);
	await page.getByRole('button', { name: 'Create and Continue' }).click();
	await page.getByLabel('Program name').fill(`Reduced program ${runId}`);
	await page.locator('#quick-setup-actions').getByRole('button', { name: 'Continue', exact: true }).click();
	await page.getByLabel('Channel name').fill(`Reduced channel ${runId}`);
	await page.getByRole('button', { name: 'Review Setup' }).click();
	await page.getByRole('button', { name: 'Create Channel', exact: true }).click();
	const dialog = page.getByRole('dialog', { name: 'Quick Setup', exact: true });
	await expect(page.getByRole('heading', { name: new RegExp(`Reduced channel ${runId}`) })).toBeVisible({ timeout: 30_000 });
	await expect(dialog).toHaveClass(/quick-setup-complete/);
	await expect(page.locator('.quick-success-morph')).toHaveCount(0);
	await expect.poll(async () => (await dialog.boundingBox())!.width).toBeLessThanOrEqual(640);
});
