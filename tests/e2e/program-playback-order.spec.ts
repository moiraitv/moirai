import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { MediaItem, SchedulingProgram } from '@moirai/shared';
import { authenticateAdministrator } from './authentication';

const libraryId = randomUUID();
const showId = randomUUID();
const programId = randomUUID();
const items = [10, 2, 1].map(episodeNumber => ({
	id: randomUUID(), libraryId, groupId: showId, showId, showSortTitle: 'Space Station',
	title: `Episode ${episodeNumber}`, sortTitle: `Episode ${episodeNumber}`, kind: 'episode',
	seasonNumber: 1, episodeNumber, year: 2026, releaseDate: null,
	availability: 'available', artworkUrl: null, metadata: {},
}) as MediaItem);
let program: SchedulingProgram;
let failSelection = false;

test.beforeEach(async ({ page }) => {
	program = { id: programId, name: 'Space Station selection', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', config: {
		type: 'content', source: { type: 'collection', libraryId, itemIds: items.map(item => item.id), sort: { type: 'date-added', direction: 'asc' } }, strategy: { type: 'sequential' },
	} };
	failSelection = false;
	await authenticateAdministrator(page);
	await page.route('**/api/v1/libraries', route => route.fulfill({ json: [{ id: libraryId, name: 'Shows', typeKey: 'shows', enabled: true }] }));
	await page.route('**/api/v1/libraries/*/genres*', route => route.fulfill({ json: [] }));
	await page.route('**/api/v1/libraries/*/media-source-options*', route => route.fulfill({ json: {
		entries: items.map(item => ({ key: item.id, item, group: null, matches: [] })), pagination: { page: 1, totalPages: 1, total: items.length, pageSize: 20 },
	} }));
	await page.route('**/api/v1/quick-channel-setups/query-preview', route => route.fulfill({ json: { items: [], indexedItemCount: 0, nextCursor: null } }));
	await page.route('**/api/v1/scheduling/overview', route => route.fulfill({ json: { programs: [program], templates: [], channelSchedules: [], programStatuses: [] } }));
	await page.route('**/api/v1/resource-usage/program/**', route => route.fulfill({ json: { total: 0, items: [] } }));
	await page.route('**/api/v1/libraries/*/media-selection', route => failSelection
		? route.fulfill({ status: 503, json: { message: 'Unavailable' } })
		: route.fulfill({ json: route.request().postDataJSON().itemIds.flatMap((id: string) => items.filter(item => item.id === id)) }));
	await page.route(`**/api/v1/programs/${programId}`, async route => {
		program = { ...program, ...route.request().postDataJSON() };
		await route.fulfill({ json: program });
	});
});

for (const width of [1440, 390]) {
	test(`edits the same order inline and in review, saves and reopens at width ${width}`, async ({ page }) => {
		await page.setViewportSize({ width, height: 900 });
		if (width === 390) {
			await page.emulateMedia({ reducedMotion: 'reduce' });
		}
		await page.goto(`/schedules/programs/${programId}`);
		const order = page.locator('.program-playback-order');
		const disclosure = order.getByRole('button', { name: /Playback order/ });
		await expect(disclosure).toHaveAttribute('aria-expanded', 'true');
		await expect(order.getByLabel('Sort selected media')).toHaveValue('date-added');
		await expect(page.getByRole('button', { name: 'Close', exact: true })).toBeEnabled();
		await expect(order.locator('.selected-item-copy strong')).toHaveText(['Episode 10', 'Episode 2', 'Episode 1']);
		await disclosure.click();
		await expect(disclosure).toContainText('Date Added to Program');
		await expect(order.getByLabel('Sort selected media')).toBeHidden();
		await disclosure.click();
		await order.getByLabel('Sort selected media').selectOption('episode');
		await expect(order.locator('.selected-item-copy strong')).toHaveText(['Episode 1', 'Episode 2', 'Episode 10']);
		await expect(order.locator('.selected-item-position')).toHaveText(['1', '2', '3']);
		await page.getByRole('button', { name: 'Review Selection', exact: true }).click();
		const drawer = page.getByRole('dialog', { name: 'Review selection' });
		await expect(drawer.getByLabel('Sort selected media')).toHaveValue('episode');
		await drawer.getByLabel('Sort selected media').selectOption('manual');
		await drawer.getByRole('button', { name: 'Move Episode 10 earlier' }).focus();
		await page.keyboard.press('Enter');
		await drawer.getByRole('button', { name: 'Done', exact: true }).click();
		await expect(page.getByRole('button', { name: 'Review Selection', exact: true })).toBeFocused();
		await expect(order.locator('.selected-item-copy strong')).toHaveText(['Episode 1', 'Episode 10', 'Episode 2']);
		await order.getByRole('searchbox', { name: 'Search selected media' }).fill('Episode 10');
		await expect(order.getByRole('button', { name: 'Drag Episode 10 to reorder' })).toBeDisabled();
		await order.getByRole('searchbox', { name: 'Search selected media' }).fill('');
		await page.getByRole('button', { name: /^Shuffle \(no repeats\)/ }).click();
		await expect(order).toHaveCount(0);
		await page.getByRole('button', { name: /^Sequential/ }).click();
		await expect(disclosure).toHaveAttribute('aria-expanded', 'true');
		await expect(order.getByLabel('Sort selected media')).toHaveValue('manual');
		await page.getByRole('button', { name: 'Save', exact: true }).click();
		await expect(page.getByRole('button', { name: 'Close', exact: true })).toBeEnabled();
		await expect(order.locator('.selected-item-copy strong')).toHaveText(['Episode 1', 'Episode 10', 'Episode 2']);
		await expect(page).toHaveURL(`/schedules/programs/${programId}`);
		await page.goto(`/schedules/programs/${programId}`);
		await expect(order.locator('.selected-item-copy strong')).toHaveText(['Episode 1', 'Episode 10', 'Episode 2']);
		await expect(page.getByRole('button', { name: 'Close', exact: true })).toBeEnabled();
		await order.scrollIntoViewIfNeeded();
		expect(await order.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
		await page.screenshot({ path: `test-results/playback-order-${width}.png`, fullPage: true });
	});
}

test('defaults new episode selections and resets a changed draft to its saved baseline', async ({ page }) => {
	await page.goto('/schedules/programs/new');
	await page.getByLabel('Source type').selectOption('collection');
	const order = page.locator('.program-playback-order');
	await expect(order.getByLabel('Sort selected media')).toHaveValue('episode');
	await page.goto(`/schedules/programs/${programId}`);
	await order.getByLabel('Sort selected media').selectOption('episode');
	await page.getByRole('button', { name: 'Reset', exact: true }).click();
	await page.getByRole('button', { name: 'Confirm Reset', exact: true }).click();
	await expect(order.getByLabel('Sort selected media')).toHaveValue('date-added');
	await expect(page.getByRole('button', { name: 'Close', exact: true })).toBeEnabled();
});

test('keeps specific group review cards available after saving the open editor', async ({ page }) => {
	program.config = { type: 'content', source: { type: 'group-collection', libraryId, groupIds: [showId] }, strategy: { type: 'sequential' } };
	await page.route('**/api/v1/libraries/*/media-group-selection', route => route.fulfill({ json: [
		{ id: showId, libraryId, kind: 'show', title: 'Space Station', year: 2026, yearEnd: null, childCount: 1, artworkUrl: null },
	] }));
	await page.goto(`/schedules/programs/${programId}`);
	await expect(page.locator('.selected-collection-summary')).toContainText('Maximum');
	await page.getByRole('textbox', { name: /^Name/u }).fill('Updated group Program');
	await expect(page.getByRole('textbox', { name: /^Name/u })).toHaveValue('Updated group Program');
	await page.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(page.getByRole('button', { name: 'Close', exact: true })).toBeEnabled();
	await page.getByRole('button', { name: 'Review Selection', exact: true }).click();
	const drawer = page.getByRole('dialog', { name: 'Review selection' });
	await expect(drawer.locator('.selected-item-copy strong')).toHaveText(['Space Station']);
	await expect(drawer.getByRole('alert')).toHaveCount(0);
});

test('shows loading, a persistent failure, and recovery without claiming the selection is empty', async ({ page }) => {
	failSelection = true;
	await page.goto(`/schedules/programs/${programId}`);
	const order = page.locator('.program-playback-order');
	await expect(order.getByRole('alert')).toContainText('Could not load the selection.');
	await expect(order.getByText('No media selected.')).toHaveCount(0);
	failSelection = false;
	let resume: (() => void) | undefined;
	const gate = new Promise<void>(resolve => {
		resume = resolve; 
	});
	await page.route('**/api/v1/libraries/*/media-selection', async route => {
		await gate;
		await route.fulfill({ json: items });
	});
	await order.getByRole('button', { name: 'Try again' }).click();
	await expect(order.getByRole('status')).toContainText('Loading selected media');
	await expect(order.getByText('No media selected.')).toHaveCount(0);
	resume!();
	await expect(order.locator('.selected-item-copy strong')).toHaveCount(3);
});

test('drags a manual item and preserves missing references when saving', async ({ page }) => {
	const missingId = randomUUID();
	if (program.config.type === 'content' && program.config.source.type === 'collection') {
		program.config.source.itemIds.push(missingId);
	}
	await page.goto(`/schedules/programs/${programId}`);
	const order = page.locator('.program-playback-order');
	await expect(order).toContainText('1 selected item reference');
	await order.getByLabel('Sort selected media').selectOption('manual');
	const handle = order.getByRole('button', { name: 'Drag Episode 10 to reorder' });
	await handle.scrollIntoViewIfNeeded();
	const from = (await handle.boundingBox())!;
	const target = (await order.locator('.selected-item-preview').last().boundingBox())!;
	await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
	await page.mouse.down();
	await page.mouse.move(target.x + target.width - 5, target.y + target.height / 2, { steps: 15 });
	await page.mouse.up();
	await expect(order.locator('.selected-item-copy strong')).toHaveText(['Episode 2', 'Episode 1', 'Episode 10']);
	await page.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(page).toHaveURL(`/schedules/programs/${programId}`);
	expect(program.config).toMatchObject({ source: { sort: { type: 'manual', itemIds: [items[1]!.id, items[2]!.id, items[0]!.id, missingId] } } });
});

test('offers explicit episode order for an AI selection while retaining its existing default', async ({ page }) => {
	program.config = { type: 'content', source: { type: 'ai', libraryId, prompt: 'Space Station episodes', itemIds: items.map(item => item.id), sort: { type: 'date-added', direction: 'asc' } }, strategy: { type: 'sequential' } };
	await page.goto(`/schedules/programs/${programId}`);
	await expect(page.getByLabel('AI selection order')).toHaveValue('date-added');
	await page.getByLabel('AI selection order').selectOption('episode');
	await expect(page.locator('.program-playback-order')).toContainText('Season / episode');
	await page.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(page).toHaveURL(`/schedules/programs/${programId}`);
	expect(program.config).toMatchObject({ source: { sort: { type: 'episode', direction: 'asc' } } });
});
