import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { SECONDS_PER_SCHEDULING_DAY } from '@moirai/shared';
import { authenticateAdministrator } from './authentication';

const updateScreenshots = process.env.MOIRAI_DOCS_SCREENSHOT_UPDATE === '1';
const screenshotRoot = updateScreenshots
	? path.resolve('apps/docs/src/public/screenshots')
	: path.resolve('test-results/docs-screenshots');
const posterFixtureRoot = path.resolve('tests/e2e/fixtures/user-documentation');

/** Load an optional purpose-built poster while retaining a usable bootstrap fallback. */
async function documentationPoster(fileName: string): Promise<Buffer> {
	try {
		return await readFile(path.join(posterFixtureRoot, fileName));
	}
	catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
			throw error;
		}

		return readFile(path.resolve('apps/web/src/assets/moirai-logo.png'));
	}
}

/** Replace changing human-readable timestamps before capturing documentation pixels. */
async function sanitizeDynamicText(page: Page): Promise<void> {
	await page.evaluate(() => {
		const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
		let node = walker.nextNode();
		while (node) {
			node.textContent = node.textContent
				?.replace(
					/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2}, \d{4}, \d{1,2}:\d{2}:\d{2} [AP]M\b/gu,
					'Jan 15, 2026, 10:30:00 AM',
				)
				.replace(
					/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2}, \d{4}\b/gu,
					'Jan 15, 2026',
				)
				.replace(
					/\b\d{1,2}\/\d{1,2}\/\d{4}\b/gu,
					'01/15/2026',
				) ?? '';
			node = walker.nextNode();
		}
		for (const input of document.querySelectorAll<HTMLInputElement>('input[type="date"]')) {
			input.value = '2026-01-15';
			input.setAttribute('value', '2026-01-15');
		}
		for (const element of document.querySelectorAll<HTMLElement>('[style*="--program-color"]')) {
			element.style.setProperty('--program-color', '#2997ff', 'important');
			element.style.setProperty('--program-color-dark', '#185895', 'important');
			element.style.setProperty('--program-color-glow', 'rgba(41, 151, 255, 0.24)', 'important');
			element.style.setProperty('--program-color-foreground', '#ffffff', 'important');
		}
		document.querySelector('.public-url-warning')?.remove();
	});
}

/** Capture one stable documentation viewport after visible loading has settled. */
async function capture(page: Page, name: string): Promise<void> {
	await mkdir(screenshotRoot, { recursive: true });
	await sanitizeDynamicText(page);
	await page.screenshot({
		path: path.join(screenshotRoot, name),
		animations: 'disabled',
		fullPage: false,
	});
}

test('captures the released administrator workflows for the user guide', async ({ page }) => {
	test.setTimeout(180_000);
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' });

	await page.goto('/setup');
	await expect(page.getByRole('heading', { name: 'Create user' })).toBeVisible();
	await capture(page, 'administrator-setup.png');

	const csrfToken = await authenticateAdministrator(page);
	const requestHeaders = { 'x-moirai-csrf': csrfToken };
	await page.goto('/');
	await expect(page.getByRole('heading', { name: 'Moirai overview' })).toBeVisible();
	await capture(page, 'dashboard.png');

	await page.goto('/libraries');
	await expect(page.getByText('Build your first library')).toBeVisible();
	await capture(page, 'libraries.png');

	const mediaRoot = path.resolve('test-results/runtime/docs-media');
	const mediaFixtures = [
		{
			title: 'Afterlight Station',
			year: 2026,
			plot: 'A repair crew receives one final transmission from an abandoned orbital station.',
			rating: 8.1,
			genre: 'Science Fiction',
			poster: 'afterlight-station-poster.png',
		},
		{
			title: 'Borrowed Summer',
			year: 2020,
			plot: 'Three generations return to a harbor town for one unforgettable summer.',
			rating: 7.4,
			genre: 'Drama',
			poster: 'borrowed-summer-poster.png',
		},
		{
			title: 'Checkout Please',
			year: 2025,
			plot: 'An understaffed neighborhood market survives its most chaotic sale day.',
			rating: 7.7,
			genre: 'Comedy',
			poster: 'checkout-please-poster.png',
		},
		{
			title: 'Cinder Atlas',
			year: 2024,
			plot: 'An explorer follows a scorched map toward a city hidden between volcanoes.',
			rating: 8.3,
			genre: 'Adventure',
			poster: 'cinder-atlas-poster.png',
		},
		{
			title: 'Echo Harbor',
			year: 2023,
			plot: 'A harbor radio operator follows an impossible signal through a citywide storm.',
			rating: 7.6,
			genre: 'Mystery',
			poster: 'echo-garden-poster.png',
		},
		{
			title: 'Glass Midnight',
			year: 2022,
			plot: 'A courier crosses a luminous city while its artificial moon begins to fracture.',
			rating: 8,
			genre: 'Science Fiction',
			poster: 'glass-midnight-poster.png',
		},
		{
			title: 'Harbor Static',
			year: 2021,
			plot: 'A vanished cargo ship returns as a pattern of light on the harbor water.',
			rating: 7.5,
			genre: 'Thriller',
			poster: 'harbor-static-poster.png',
		},
		{
			title: 'Little Machines',
			year: 2024,
			plot: 'A young inventor and a lively workshop of robots set out to repair their town.',
			rating: 8.5,
			genre: 'Animation',
			poster: 'little-machines-poster.png',
		},
		{
			title: 'Moonrise Theater',
			year: 2024,
			plot: 'A quiet late-night mystery staged inside a grand neighborhood cinema.',
			rating: 8.2,
			genre: 'Drama',
			poster: 'moonrise-theater-poster.png',
		},
		{
			title: 'Northbound Zero',
			year: 2023,
			plot: 'A rescue courier races across a frozen rail line before the final pass closes.',
			rating: 7.9,
			genre: 'Action',
			poster: 'northbound-zero-poster.png',
		},
		{
			title: 'Paper Constellations',
			year: 2022,
			plot: 'Two artists turn a rooftop installation into a map of their shared history.',
			rating: 7.8,
			genre: 'Romance',
			poster: 'paper-constellations-poster.png',
		},
		{
			title: 'Quiet Orbit',
			year: 2025,
			plot: 'A patient view of the instruments listening to Earth from above.',
			rating: 8.6,
			genre: 'Documentary',
			poster: 'quiet-orbit-poster.png',
		},
		{
			title: 'Red Current',
			year: 2021,
			plot: 'A fishing crew follows a glowing tide toward a lighthouse erased from every chart.',
			rating: 7.3,
			genre: 'Thriller',
			poster: 'red-current-poster.png',
		},
		{
			title: 'Signal Garden',
			year: 2025,
			plot: 'A botanist discovers that an abandoned glasshouse is receiving messages from the stars.',
			rating: 7.8,
			genre: 'Science Fiction',
			poster: 'signal-garden-poster.png',
		},
		{
			title: 'The Last Crossing',
			year: 2019,
			plot: 'A field hospital unit follows a ruined road toward the last bridge out of the valley.',
			rating: 8.1,
			genre: 'Historical Drama',
			poster: 'the-last-crossing-poster.png',
		},
		{
			title: 'The Last Lighthouse',
			year: 2021,
			plot: 'A solitary keeper climbs toward the final light during an unnatural coastal storm.',
			rating: 8.4,
			genre: 'Adventure',
			poster: 'the-last-lighthouse-poster.png',
		},
		{
			title: 'Winter Archive',
			year: 2020,
			plot: 'An archivist finds a sealed collection that rewrites the history of her frozen city.',
			rating: 8.2,
			genre: 'Mystery',
			poster: 'winter-archive-poster.png',
		},
	] as const;
	const authoredPosterFiles = (await readdir(posterFixtureRoot))
		.filter((fileName) => fileName.endsWith('-poster.png'))
		.sort();
	expect(authoredPosterFiles).toEqual(mediaFixtures.map((fixture) => fixture.poster).sort());
	await rm(mediaRoot, { recursive: true, force: true });
	await mkdir(mediaRoot, { recursive: true });
	await Promise.all(mediaFixtures.map(async (fixture) => {
		const poster = await documentationPoster(fixture.poster);
		await Promise.all([
			writeFile(path.join(mediaRoot, `${fixture.title}.mp4`), 'documentation fixture'),
			writeFile(
				path.join(mediaRoot, `${fixture.title}.nfo`),
				`<movie><title>${fixture.title}</title><year>${fixture.year}</year><plot>${fixture.plot}</plot><rating>${fixture.rating}</rating><genre>${fixture.genre}</genre><director>Sam Rivera</director><actor><name>Alex Morgan</name><role>Host</role></actor></movie>`,
			),
			writeFile(path.join(mediaRoot, `${fixture.title}-poster.png`), poster),
		]);
	}));

	await page.locator('.resource-empty-state').getByRole('button', { name: 'Add Library' }).click();
	await page.getByLabel('Name').fill('Evening Cinema');
	await page.getByLabel('Path Moirai scans').fill(mediaRoot);
	await page.getByRole('button', { name: 'Add and Scan' }).click();
	const libraryLink = page.getByRole('link', { name: 'Open library Evening Cinema' });
	await expect(libraryLink).toBeVisible();
	await expect(page.getByText('17 indexed')).toBeVisible();
	const libraryId = (await libraryLink.getAttribute('href'))?.split('/').at(-1);
	if (!libraryId) {
		throw new Error('Created library link did not contain an id');
	}
	await libraryLink.click();
	await expect(page.getByRole('heading', { name: 'Evening Cinema' })).toBeVisible();
	const mediaIds: string[] = [];
	for (const fixture of mediaFixtures) {
		const itemLink = page.getByRole('link', { name: new RegExp(fixture.title, 'u') }).first();
		const itemId = (await itemLink.getAttribute('href'))?.split('/').at(-1);
		if (!itemId) {
			throw new Error(`Indexed media link for ${fixture.title} did not contain an id`);
		}
		mediaIds.push(itemId);
	}
	await capture(page, 'library-catalog.png');

	await page.getByRole('link', { name: /Moonrise Theater/u }).first().click();
	await expect(page.getByRole('heading', { name: 'Moonrise Theater' })).toBeVisible();
	await capture(page, 'media-item.png');

	const programResponse = await page.request.post('/api/v1/programs', {
		headers: requestHeaders,
		data: {
			name: 'Midnight Feature Collection',
			config: {
				type: 'content',
				source: { type: 'collection', libraryId, itemIds: mediaIds },
				strategy: { type: 'sequential' },
			},
		},
	});
	expect(programResponse.ok(), await programResponse.text()).toBe(true);
	const program = await programResponse.json() as { id: string };
	const slotId = randomUUID();
	const templateResponse = await page.request.post('/api/v1/schedule-templates', {
		headers: requestHeaders,
		data: {
			name: 'Evening Cinema Day',
			slots: [{ id: slotId, startSeconds: 0, programId: program.id }],
			boundaries: [{
				id: randomUUID(),
				leftSlotId: slotId,
				rightSlotId: slotId,
				targetSeconds: SECONDS_PER_SCHEDULING_DAY,
				policy: 'hard',
			}],
		},
	});
	expect(templateResponse.ok(), await templateResponse.text()).toBe(true);
	const template = await templateResponse.json() as { id: string };
	const channelResponse = await page.request.post('/api/v1/channels', {
		headers: requestHeaders,
		data: { number: '7.1', name: 'Moonrise Classics' },
	});
	expect(channelResponse.ok(), await channelResponse.text()).toBe(true);
	const channel = await channelResponse.json() as { id: string };

	const pages: Array<[string, string, string]> = [
		['/schedules/programs', 'Programs', 'programs.png'],
		['/schedules/templates', 'Templates', 'templates.png'],
		['/channels', 'Channels', 'channels.png'],
		['/guide', 'Guide', 'guide.png'],
		['/settings', 'IPTV service', 'settings.png'],
		['/logs', 'Logs', 'logs.png'],
		['/account', 'Account', 'account.png'],
	];
	for (const [url, heading, screenshot] of pages) {
		await page.goto(url);
		await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible({
			timeout: 20_000,
		});
		await capture(page, screenshot);
	}

	const scheduleResponse = await page.request.put(`/api/v1/channels/${channel.id}/schedule`, {
		headers: requestHeaders,
		data: { defaultTemplateId: template.id },
	});
	expect(scheduleResponse.ok(), await scheduleResponse.text()).toBe(true);
	await page.goto(`/schedules/channels/${channel.id}`);
	await expect(page.getByRole('dialog', { name: 'Channel schedule editor' })).toBeVisible({
		timeout: 30_000,
	});
	await expect(page.getByRole('heading', { name: 'Preview layered schedule' })).toBeVisible();
	await expect(page.locator('.scheduling-preview-dock .resolved-segment').first()).toBeVisible({
		timeout: 30_000,
	});
	await page.locator('.scheduling-workspace-scroll').evaluate((element) => {
		element.scrollTop = 0;
	});
	await capture(page, 'channel-schedules.png');
});

test('presents accessible contextual help with draft and failure states', async ({ page }) => {
	await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' });
	await page.goto('/setup');
	await authenticateAdministrator(page);
	await page.goto('/schedules/programs');

	const helpButton = page.getByRole('button', { name: 'Help', exact: true });
	await helpButton.click();
	const drawer = page.getByRole('dialog');
	await expect(drawer).toBeFocused();
	await expect(drawer.getByRole('heading', { name: 'Programs' })).toBeVisible();
	await expect(drawer.getByText('Needs review', { exact: true })).toBeVisible();
	await expect(drawer.getByRole('link', { name: 'Open full guide' })).toHaveAttribute(
		'href',
		'/help/scheduling/programs.html',
	);
	const animationSeconds = await drawer.evaluate((element) =>
		Number.parseFloat(getComputedStyle(element).animationDuration));
	expect(animationSeconds).toBeLessThanOrEqual(0.001);

	await page.keyboard.press('Escape');
	await expect(drawer).toBeHidden();
	await expect(helpButton).toBeFocused();

	await page.route('/help/contextual-help.json', (route) => route.fulfill({ status: 503 }));
	await helpButton.click();
	await expect(drawer.getByRole('alert')).toContainText('Help returned 503');
	await drawer.getByRole('button', { name: 'Close help' }).click();
	await expect(drawer).toBeHidden();
});
