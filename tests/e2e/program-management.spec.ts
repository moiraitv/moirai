import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { authenticateAdministrator } from './authentication';
import type { SchedulingProgram } from '@moirai/shared';

const libraryId = randomUUID();
const itemId = randomUUID();
const sourceId = randomUUID();
const programs: SchedulingProgram[] = Array.from({ length: 300 }, (_, index) => ({
	id: index === 0 ? sourceId : randomUUID(), name: `Program ${String(index).padStart(3, '0')}`,
	createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z',
	config: { type: 'content', source: { type: 'collection', libraryId, itemIds: [itemId], sort: { type: 'date-added', direction: 'asc' } }, strategy: { type: 'sequential' } },
}));
programs[1]!.config = { type: 'similarity', sourceProgramId: sourceId, variety: 65, quantity: 20 };
programs[2]!.config = { type: 'theme', libraryId, theme: 'Space discovery', variety: 35, quantity: 10 };
programs[4]!.config = { type: 'content', source: { type: 'library-query', libraryId, kinds: [], genres: ['drama'], primaryGenres: ['comedy'], releaseYearFrom: 2000 }, strategy: { type: 'sequential' } };
programs[5]!.config = { type: 'content', source: { type: 'group-collection', libraryId, groupIds: [randomUUID(), randomUUID()] }, strategy: { type: 'sequential' } };
programs[3]!.config = { type: 'sequence', entries: [{ id: randomUUID(), programId: sourceId, count: 3 }, { id: randomUUID(), programId: programs[2]!.id, count: 1 }], repeat: true };

test.beforeEach(async ({ page }) => {
	await authenticateAdministrator(page);
	await page.route('**/api/v1/scheduling/overview', route => route.fulfill({ json: {
		programs, templates: [], channelSchedules: [], programStatuses: programs.map(program => ({ programId: program.id, health: 'ready', sourceLabel: 'Selected media', indexedItemCount: 1, availableItemCount: 1, previewItems: [{ id: itemId, libraryId, title: 'Preview movie', year: 2026, artworkUrl: null, availability: 'available' }] })),
	} }));
	await page.route('**/api/v1/resource-usage/program/**', route => route.fulfill({ json: { total: 0, items: [] } }));
});

test('virtualizes a large collection and preserves URL filtering and selection', async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto('/schedules/programs');
	await expect(page.getByRole('button', { name: 'Program 000', exact: true })).toBeVisible();
	expect(await page.locator('.program-management-row').count()).toBeLessThan(30);
	await expect(page.locator('.program-inspector')).toHaveCount(0);
	await page.getByRole('button', { name: 'Program 000', exact: true }).focus();
	await page.keyboard.press('End');
	await expect(page.getByRole('button', { name: 'Program 299', exact: true })).toBeFocused();
	await page.getByRole('button', { name: 'Actions for Program 299' }).click();
	await expect(page.getByRole('link', { name: 'Edit Program', exact: true })).toBeInViewport();
	await page.keyboard.press('Escape');
	await page.getByRole('button', { name: 'Program 299', exact: true }).focus();
	await page.keyboard.press('Home');
	await page.getByRole('button', { name: /^Program 000/ }).click();
	await expect(page.getByRole('region', { name: 'Program 000', exact: true })).toBeVisible();
	await expect(page.locator('.program-inspector')).toContainText('Specific Items');
	await page.getByRole('searchbox', { name: 'Search programs' }).fill('299');
	await expect(page.locator('.program-management-row')).toHaveCount(1);
	await expect(page.locator('.program-inspector')).toBeVisible();
	await page.getByRole('button', { name: 'Close program inspector' }).click();
	await expect(page.locator('.program-management-list')).toBeFocused();
	await page.getByRole('searchbox').fill('');
	await page.getByLabel('Filter program usage').selectOption('used');
	await expect(page.locator('.program-management-row')).toHaveCount(2);
	await page.getByLabel('Filter programs by type').selectOption('theme');
	await expect(page.locator('.program-management-row')).toHaveCount(1);
	await page.getByRole('button', { name: /^Program 002/ }).click();
	await expect(page.locator('.program-inspector')).toContainText('Space discovery');
	await page.reload();
	await expect(page.locator('.program-inspector')).toContainText('Space discovery');
});

for (const viewport of [{ width: 1440, height: 900 }, { width: 1024, height: 768 }, { width: 768, height: 1024 }, { width: 390, height: 844 }]) {
	test(`inspects definitions and dismisses at ${viewport.width}x${viewport.height}`, async ({ page }) => {
		await page.setViewportSize(viewport);
		await page.goto('/schedules/programs');
		const opener = page.getByRole('button', { name: /^Program 001/ });
		await opener.click();
		const inspector = page.locator('.program-inspector');
		await expect(inspector.locator('header .program-subtype-badge')).toHaveText('Based on “Program 000”');
		await expect(inspector).toContainText('65 / 100');
		await expect(inspector).toContainText('Current sets');
		await expect(inspector.getByRole('region', { name: 'Sample matches' })).toBeVisible();
		if (viewport.width <= 1220) {
			await expect(inspector).toHaveAttribute('aria-modal', 'true');
			await expect(inspector).toBeFocused();
			const box = await inspector.boundingBox();
			const ratio = viewport.width <= 680 ? 1 : viewport.width <= 900 ? .85 : .44;
			expect(Math.abs(box!.width - viewport.width * ratio)).toBeLessThan(2);
		}
		else {
			await inspector.focus();
		}
		await page.screenshot({ animations: 'disabled', path: `test-results/program-management-${viewport.width}.png` });
		await page.keyboard.press('Escape');
		await expect(inspector).toHaveCount(0);
		await expect(opener).toBeFocused();
		await page.getByRole('button', { name: /^Program 003/ }).click();
		await expect(inspector.locator('header .program-subtype-badge')).toHaveText('2 Programs');
		await expect(inspector.getByRole('region', { name: 'Source preview' })).toBeVisible();
		await expect(inspector.getByRole('region', { name: 'Source preview' })).toContainText('Preview movie');
		await expect(inspector.locator('.program-source-copy')).toHaveText(['Program 0003 Items', 'Program 0021 Item']);
		await expect(inspector.locator('.program-source-more:visible')).toHaveCount(0);
		await page.screenshot({ animations: 'disabled', path: `test-results/sequence-inspector-${viewport.width}.png` });
		await inspector.getByRole('button', { name: '2. Program 002, 1 Item', exact: true }).click();
		await expect(inspector.locator('header .program-subtype-badge')).toHaveText('Prompt: Space discovery');
		await expect(inspector).toContainText('Space discovery');
		await page.goBack();
		await expect(inspector).toContainText('Sequence Configuration');
	});
}

test('distinguishes initial loading, failed loading, and loaded empty results', async ({ page }) => {
	let release: () => void = () => {};
	const gate = new Promise<void>(resolve => {
		release = resolve;
	});
	await page.route('**/api/v1/scheduling/overview', async route => {
		await gate;
		await route.fulfill({ status: 503, json: { message: 'Overview unavailable' } });
	});
	await page.goto('/schedules/programs');
	await expect(page.getByText('Loading programs…')).toBeVisible();
	await expect(page.getByText('No programs yet')).toHaveCount(0);
	release();
	await expect(page.getByRole('button', { name: 'Retry', exact: true })).toBeVisible();
	await expect(page.getByText('No programs yet')).toHaveCount(0);
	await page.route('**/api/v1/scheduling/overview', route => route.fulfill({ json: { programs: [], templates: [], channelSchedules: [], programStatuses: [] } }));
	await page.getByRole('button', { name: 'Retry', exact: true }).click();
	await expect(page.getByRole('heading', { name: 'No programs yet' })).toBeVisible();
});

test('keeps deletion errors inside the drawer and requires confirmation', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	let attempted = false;
	await page.route(`**/api/v1/programs/${sourceId}`, route => {
		attempted = true;
		return route.fulfill({ status: 409, json: { message: 'Program is in use' } });
	});
	await page.goto(`/schedules/programs?selected=${sourceId}`);
	const inspector = page.locator('.program-inspector');
	await inspector.getByRole('button', { name: 'Delete Program', exact: true }).click();
	expect(attempted).toBe(false);
	await inspector.getByRole('button', { name: 'Confirm Delete Program', exact: true }).press('Escape');
	await expect(inspector).toBeVisible();
	await inspector.getByRole('button', { name: 'Delete Program', exact: true }).click();
	await inspector.getByRole('button', { name: 'Confirm Delete Program', exact: true }).click();
	await expect(inspector.getByRole('alert')).toContainText('Program is in use');
	await expect(inspector).toBeVisible();
});

test('preserves literal all search text while resetting filters', async ({ page }) => {
	await page.goto('/schedules/programs');
	const search = page.getByRole('searchbox', { name: 'Search programs' });
	await search.fill('al');
	await expect(search).toHaveValue('al');
	await search.pressSequentially('l');
	await expect(search).toHaveValue('all');
	expect(new URL(page.url()).searchParams.get('q')).toBe('all');
	await search.pressSequentially(' programs');
	await expect(search).toHaveValue('all programs');
	await page.getByLabel('Filter programs by type').selectOption('content');
	await page.getByLabel('Filter Content definition').selectOption('items');
	await page.getByLabel('Filter program usage').selectOption('unused');
	await page.getByLabel('Filter Content definition').selectOption('all');
	await page.getByLabel('Filter program usage').selectOption('all');
	await page.getByLabel('Filter programs by type').selectOption('all');
	await expect(search).toHaveValue('all programs');
	await expect.poll(() => new URL(page.url()).searchParams.toString()).toBe('q=all+programs');
});

test('dismisses the backdrop after changing an inline inspector into a drawer', async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto('/schedules/programs');
	const opener = page.getByRole('button', { name: 'Program 000', exact: true });
	for (const viewport of [{ width: 1024, height: 768 }, { width: 768, height: 1024 }]) {
		await page.setViewportSize({ width: 1440, height: 900 });
		await opener.click();
		await expect(page.getByRole('region', { name: 'Program 000', exact: true })).toBeVisible();
		await page.setViewportSize(viewport);
		await expect(page.getByRole('dialog', { name: 'Program 000', exact: true })).toBeFocused();
		await page.locator('.program-inspector-backdrop').click({ position: { x: 20, y: 300 } });
		await expect(page.locator('.program-inspector')).toHaveCount(0);
		await expect(opener).toBeFocused();
		expect(new URL(page.url()).searchParams.has('selected')).toBe(false);
	}
});

test('adapts an open inspector across breakpoints and respects reduced motion', async ({ page }) => {
	await page.emulateMedia({ reducedMotion: 'reduce' });
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto(`/schedules/programs?selected=${sourceId}`);
	await expect(page.getByRole('region', { name: 'Program 000', exact: true })).toBeVisible();
	await page.setViewportSize({ width: 768, height: 1024 });
	await expect(page.getByRole('dialog', { name: 'Program 000', exact: true })).toBeVisible();
	await expect(page.locator('.program-inspector')).toBeFocused();
	await page.keyboard.press('Tab');
	await expect(page.getByRole('button', { name: 'Close program inspector' })).toBeFocused();
	await page.setViewportSize({ width: 1440, height: 900 });
	await expect(page.getByRole('region', { name: 'Program 000', exact: true })).toBeVisible();
	await page.getByRole('searchbox').fill('299');
	await expect(page.locator('.program-management-row')).toHaveCount(1);
});


test('filters Content definitions and summarizes query and group selections', async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto('/schedules/programs?type=content&subtype=query');
	await expect(page.locator('.program-management-row')).toHaveCount(1);
	await page.getByRole('button', { name: 'Program 004', exact: true }).click();
	await expect(page.locator('.program-inspector')).toContainText('Years: 2000+');
	await expect(page.locator('.program-inspector')).toContainText('All genres: drama');
	await expect(page.locator('.program-inspector')).toContainText('Primary (all): comedy');
	await page.getByLabel('Filter Content definition').selectOption('groups');
	await expect(page.locator('.program-management-row')).toHaveCount(1);
	await page.getByRole('button', { name: 'Program 005', exact: true }).click();
	await expect(page.locator('.program-inspector')).toContainText('Specific Groups');
	await expect(page.locator('.program-inspector dd').last()).toHaveText('2');
});

test('keeps the desktop inspector beside the list throughout dismissal', async ({ page }) => {
	await page.emulateMedia({ reducedMotion: 'no-preference' });
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto(`/schedules/programs?selected=${sourceId}`);
	await expect(page.locator('.program-inspector-inline')).toHaveCSS('opacity', '1');
	const result = await page.evaluate(async () => {
		const inspector = document.querySelector<HTMLElement>('.program-inspector-inline')!;
		const catalog = document.querySelector<HTMLElement>('.program-management-catalog')!;
		const before = inspector.getBoundingClientRect().toJSON();
		const catalogWidth = catalog.getBoundingClientRect().width;
		const frames: Array<{ x: number; y: number; width: number; height: number; catalogWidth: number }> = [];
		inspector.querySelector<HTMLButtonElement>('[aria-label="Close program inspector"]')!.click();
		await new Promise<void>(resolve => {
			function sample(): void {
				if (!inspector.isConnected || frames.length >= 120) {
					resolve();
					return;
				}
				const bounds = inspector.getBoundingClientRect();
				frames.push({ x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, catalogWidth: catalog.getBoundingClientRect().width });
				requestAnimationFrame(sample);
			}
			requestAnimationFrame(sample);
		});
		return { before, catalogWidth, frames, removed: !inspector.isConnected, finalCatalogWidth: catalog.getBoundingClientRect().width };
	});
	expect(result.removed).toBe(true);
	expect(result.frames.length).toBeGreaterThan(1);
	for (const frame of result.frames) {
		for (const dimension of ['x', 'y', 'width', 'height'] as const) {
			expect(Math.abs(frame[dimension] - result.before[dimension])).toBeLessThan(1);
		}
		expect(Math.abs(frame.catalogWidth - result.catalogWidth)).toBeLessThan(1);
	}
	expect(result.finalCatalogWidth).toBeGreaterThan(result.catalogWidth);
	await expect(page.getByRole('button', { name: 'Program 000', exact: true })).toBeFocused();
});

test('shows indexed counts, unavailable tooltips, library labels and responsive previews', async ({ page }) => {
	const program = { ...programs[4]!, config: { type: 'content', source: { type: 'library-query', libraryId, kinds: ['movie'] }, strategy: { type: 'weighted-random' } } };
	await page.route('**/api/v1/libraries', route => route.fulfill({ json: [{ id: libraryId, name: 'Movie Library', typeKey: 'movies' }] }));
	await page.route('**/api/v1/scheduling/overview', route => route.fulfill({ json: {
		programs: [program], templates: [], channelSchedules: [], programStatuses: [{ programId: program.id, health: 'degraded', sourceLabel: 'Library query', indexedItemCount: 10, availableItemCount: 8, previewItems: Array.from({ length: 8 }, (_, index) => ({ id: `preview-${index}`, libraryId, title: `Preview ${index}`, artworkUrl: null, availability: 'available' })) }],
	} }));
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto('/schedules/programs');
	const count = page.locator('.program-management-count');
	await expect(count).toHaveText('10');
	await expect(count).toHaveAttribute('title', '2 unavailable');
	await expect(page.locator('.program-management-columns')).not.toContainText('Updated');
	for (const [width, visible] of [[1050, 6], [900, 5], [800, 4], [700, 3], [600, 0]]) {
		await page.locator('.program-management-catalog').evaluate((element, size) => {
			element.style.width = `${size}px`; 
		}, width!);
		await expect(page.locator('.program-mini-preview > span:visible')).toHaveCount(visible!);
	}
	await page.locator('.program-management-catalog').evaluate(element => {
		element.style.width = ''; 
	});
	await page.getByRole('button', { name: program.name, exact: true }).click();
	const inspector = page.locator('.program-inspector');
	await expect(inspector.locator('header')).toContainText('Library Query');
	await expect(inspector.locator('.program-inspector-health')).toHaveText('Degraded · 8/10 available');
	await expect(inspector.locator('dt', { hasText: 'Source Library' }).locator('+ dd')).toHaveText('Movie Library');
	await expect(inspector.locator('dt', { hasText: 'Selection' }).locator('+ dd')).toHaveText('Weighted Random');
	await expect(inspector).not.toContainText('Media kinds');
});

test('disarms inspector deletion on selection change and outside interaction, and disables pending deletion', async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto(`/schedules/programs?selected=${sourceId}`);
	const inspector = page.locator('.program-inspector');
	const remove = inspector.getByRole('button', { name: 'Delete Program', exact: true });
	await remove.click();
	await inspector.getByRole('heading', { name: 'Program 000', exact: true }).click();
	await expect(remove).toBeVisible();
	await remove.click();
	await page.getByRole('button', { name: 'Program 001', exact: true }).click();
	await expect(remove).toBeVisible();
	let release: () => void = () => {};
	const gate = new Promise<void>(resolve => {
		release = resolve; 
	});
	let attempts = 0;
	await page.route(`**/api/v1/programs/${programs[1]!.id}`, async route => {
		attempts += 1;
		await gate;
		await route.fulfill({ status: 204 });
	});
	await remove.click();
	await inspector.getByRole('button', { name: 'Confirm Delete Program' }).click();
	await expect(remove).toBeDisabled();
	await expect(page.getByRole('alertdialog')).toHaveCount(0);
	expect(attempts).toBe(1);
	release();
	await expect(inspector).toHaveCount(0);
});

test('renders counted Sequence blocks with bounded source previews and missing-source fallback', async ({ page }) => {
	const sequence = { ...programs[3]!, config: { type: 'sequence', repeat: true, entries: [
		{ id: randomUUID(), programId: sourceId, count: 1 },
		{ id: randomUUID(), programId: sourceId, count: 2 },
		{ id: randomUUID(), programId: 'missing', count: 10 },
		{ id: randomUUID(), programId: programs[5]!.id, count: 3 },
		{ id: randomUUID(), programId: programs[2]!.id, count: 1 },
	] } };
	const nested = { ...programs[2]!, name: 'A very long nested source Program title that must stay on one line', config: { type: 'sequence', repeat: false, entries: [{ id: randomUUID(), programId: sourceId, count: 10 }] } };
	const previews = Array.from({ length: 4 }, (_, index) => ({ id: `sample-${index}`, libraryId, title: `Sample ${index}`, artworkUrl: null, availability: 'available' }));
	await page.route('**/api/v1/scheduling/overview', route => route.fulfill({ json: {
		programs: [programs[0], sequence, programs[5], nested], templates: [], channelSchedules: [],
		programStatuses: [sourceId, sequence.id, nested.id].map(programId => ({ programId, health: 'ready', sourceLabel: '', indexedItemCount: 4, availableItemCount: 4, previewItems: previews })),
	} }));
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto(`/schedules/programs?selected=${sequence.id}`);
	const section = page.locator('.program-sequence-configuration');
	await expect(section.locator('.eyebrow')).toHaveCSS('text-transform', 'uppercase');
	await expect(section.locator('.program-sequence-total')).toHaveText('17 items per cycle');
	await expect(section.locator('.program-source-index')).toHaveText(['1', '2', '3', '4', '5']);
	await expect(section.locator('.program-source-copy small')).toHaveText(['1 Item', '2 Items', '10 Items', '3 Items', '1 Item']);
	await expect(section.getByRole('button', { name: '3. Missing Program, 10 Items' })).toBeDisabled();
	await expect(section.locator('.program-source-placeholder')).toHaveCount(2);
	for (const [width, count] of [[350, 3], [320, 2], [280, 1]]) {
		await section.evaluate((element, value) => {
			element.style.width = `${value}px`;
		}, width!);
		await expect(section.locator('li').first().locator('.program-mini-preview > span:visible')).toHaveCount(count!);
		await expect(section.locator('li').last().locator('.program-mini-preview > span:visible')).toHaveCount(count!);
		await expect(section.locator('li').first().locator('.program-source-more')).toBeVisible();
	}
	await expect(section.locator('li').last().locator('strong')).toHaveCSS('text-overflow', 'ellipsis');
	await expect(section.locator('li').last().locator('strong')).toHaveAttribute('title', nested.name);
	await section.getByRole('button', { name: `5. ${nested.name}, 1 Item` }).focus();
	await page.keyboard.press('Enter');
	await expect(page.locator('#program-inspector-title')).toHaveText(nested.name);
	await expect(section.locator('.program-sequence-total')).toHaveText('10 items per cycle');
	await expect(section).toContainText('Plays the sequence once');
	nested.config.entries[0]!.count = 1;
	await page.reload();
	await expect(section.locator('.program-sequence-total')).toHaveText('1 item per cycle');
});
