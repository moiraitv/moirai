import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, type Page } from '@playwright/test';
import { SECONDS_PER_SCHEDULING_DAY } from '@moirai/shared';
import { authenticateAdministrator } from '../authentication';
import { registerProgramColors } from './capture';

/** Normalize machine identifiers in this isolated backend's actual retained log files. */
export async function normalizeFixtureLogs(directory: string): Promise<void> {
	const logRoot = path.join(directory, 'logs');
	for (const name of await readdir(logRoot)) {
		if (!name.endsWith('.jsonl')) {
			continue;
		}
		const file = path.join(logRoot, name);
		const records = (await readFile(file, 'utf8')).trim().split('\n').filter(Boolean)
			.map((line) => ({ ...JSON.parse(line), pid: 1, hostname: 'documentation-host' }));
		await writeFile(file, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
	}
}

/** Authored posters required by the documentation media fixture. */
const posterFixtureRoot = path.resolve('tests/e2e/fixtures/user-documentation');
/** Representative media with deterministic names and metadata. */
export const mediaFixtures = [
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

/** Scan actual fixture files, optionally exercising the library creation UI. */
export async function seedLibrary(page: Page, directory: string, throughUI = false) {
	const requestHeaders = { 'x-moirai-csrf': await authenticateAdministrator(page) };
	const mediaRoot = path.join(directory, 'media');
	const authoredPosterFiles = (await readdir(posterFixtureRoot))
		.filter((fileName) => fileName.endsWith('-poster.png'))
		.sort();
	expect(authoredPosterFiles).toEqual(mediaFixtures.map((fixture) => fixture.poster).sort());
	
	await mkdir(mediaRoot, { recursive: true });
	await Promise.all(mediaFixtures.map(async (fixture) => {
		const poster = await readFile(path.join(posterFixtureRoot, fixture.poster));
		await Promise.all([
			writeFile(path.join(mediaRoot, `${fixture.title}.mp4`), 'documentation fixture'),
			writeFile(
				path.join(mediaRoot, `${fixture.title}.nfo`),
				`<movie><title>${fixture.title}</title><year>${fixture.year}</year><plot>${fixture.plot}</plot><rating>${fixture.rating}</rating><genre>${fixture.genre}</genre><director>Sam Rivera</director><actor><name>Alex Morgan</name><role>Host</role></actor></movie>`,
			),
			writeFile(path.join(mediaRoot, `${fixture.title}-poster.png`), poster),
		]);
	}));

	await page.goto('/libraries');
	if (throughUI) {
		await page.locator('.resource-empty-state').getByRole('button', { name: 'Add Library' }).click();
		await page.getByLabel('Name').fill('Evening Cinema');
		await page.getByLabel('Path Moirai scans').fill(mediaRoot);
		await page.getByRole('button', { name: 'Add and Scan' }).click();
	}
	else {
		const response = await page.request.post('/api/v1/libraries', { headers: requestHeaders, data: {
			name: 'Evening Cinema', typeKey: 'movies', sourceType: 'on-disk', sourceConfig: { scanRoot: mediaRoot },
		} });
		expect(response.ok(), await response.text()).toBe(true);
		await page.reload();
	}
	const libraryLink = page.getByRole('link', { name: 'Open library Evening Cinema' });
	await expect(libraryLink).toBeVisible();
	await expect(page.getByText(`${mediaFixtures.length} indexed`, { exact: true })).toBeVisible();
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
	return { libraryId, mediaIds, mediaRoot, requestHeaders };
}

/** Create independent real scheduling prerequisites for one capture workflow. */
export async function seedSchedule(page: Page, directory: string) {
	const library = await seedLibrary(page, directory);
	const { libraryId, mediaIds, requestHeaders } = library;
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

	// Seed distinct sources for the three-step Sequence creation example.
	const sequenceProgramIds = [program.id];
	for (const [name, itemIds] of [
		['Evening Favorites', mediaIds.slice(0, 5)],
		['Late Night Discoveries', mediaIds.slice(5, 10)],
	] as const) {
		const response = await page.request.post('/api/v1/programs', {
			headers: requestHeaders,
			data: {
				name,
				config: {
					type: 'content',
					source: { type: 'collection', libraryId, itemIds },
					strategy: { type: 'sequential' },
				},
			},
		});
		expect(response.ok(), await response.text()).toBe(true);
		sequenceProgramIds.push((await response.json() as { id: string }).id);
	}

	registerProgramColors(page, sequenceProgramIds);
	return { ...library, program, template, channel, sequenceProgramIds };
}
