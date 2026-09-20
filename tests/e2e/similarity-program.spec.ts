import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { authenticateAdministrator } from './authentication';

test('creates, validates, reloads and edits Similar Items with only compatible sources', async ({ page }) => {
	const headers = { 'x-moirai-csrf': await authenticateAdministrator(page) };
	const ids: string[] = [];
	try {
		const sourceResponse = await page.request.post('/api/v1/programs', { headers, data: {
			name: 'Semantic anchors', config: { type: 'content', source: { type: 'collection', libraryId: randomUUID(), itemIds: [randomUUID()] }, strategy: { type: 'sequential' } },
		} });
		expect(sourceResponse.ok()).toBe(true);
		const source = await sourceResponse.json();
		ids.push(source.id);
		const queryResponse = await page.request.post('/api/v1/programs', { headers, data: {
			name: 'Incompatible query', config: { type: 'content', source: { type: 'library-query', libraryId: randomUUID() }, strategy: { type: 'sequential' } },
		} });
		const query = await queryResponse.json();
		ids.push(query.id);
		const invalid = await page.request.post('/api/v1/programs', { headers, data: {
			name: 'Invalid similarity', config: { type: 'similarity', sourceProgramId: query.id },
		} });
		expect(invalid.status()).toBe(400);

		await page.goto('/schedules/programs/new');
		await page.getByRole('radio', { name: /^Similar Items/u }).check();
		await page.getByPlaceholder('e.g. Evening Lineup').fill('Semantic recommendations');
		const select = page.getByLabel('Source Program', { exact: true });
		await expect(select.locator('option')).not.toContainText(['Incompatible query']);
		await select.selectOption(source.id);
		await expect(page.getByLabel('Quantity', { exact: true })).toHaveValue('20');
		await page.getByLabel('Quantity', { exact: true }).fill('0');
		await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
		await page.getByLabel('Quantity', { exact: true }).fill('5');
		await page.getByLabel('Cohesion / Variety', { exact: true }).fill('75');
		await page.getByLabel('Preferences', { exact: true }).fill('Slow science fiction');
		await page.getByLabel('Exclusions', { exact: true }).fill('superhero, Comedy');
		await page.getByLabel('Exclusions', { exact: true }).blur();
		await page.getByLabel('Exclusion strictness', { exact: true }).fill('65');
		const savedResponse = page.waitForResponse((response) => response.url().endsWith('/programs') && response.request().method() === 'POST');
		await page.getByRole('button', { name: 'Save', exact: true }).click();
		const saved = await (await savedResponse).json();
		ids.push(saved.id);
		expect(saved.config).toMatchObject({ type: 'similarity', sourceProgramId: source.id, variety: 75, quantity: 5, softPreferences: 'Slow science fiction', hardExclusions: ['superhero', 'Comedy'], exclusionStrictness: 65 });
		await page.goto(`/schedules/programs/${saved.id}`);
		await expect(page.getByLabel('Quantity', { exact: true })).toHaveValue('5');
		await expect(page.getByLabel('Preferences', { exact: true })).toHaveValue('Slow science fiction');
		await expect(page.getByLabel('Exclusions', { exact: true })).toHaveValue('superhero, Comedy');
		await expect(page.getByLabel('Exclusion strictness', { exact: true })).toHaveValue('65');
		await expect(page.getByLabel('Source Program', { exact: true })).toHaveValue(source.name);
		await expect(page.getByLabel('Source Program', { exact: true })).toHaveJSProperty('readOnly', true);
		await page.getByLabel('Quantity', { exact: true }).fill('10');
		await expect(page.getByLabel('Preferences', { exact: true })).toBeVisible();
		await page.getByRole('button', { name: 'Save', exact: true }).click();
		await expect.poll(async () => (await (await page.request.get(`/api/v1/programs/${saved.id}`)).json()).config.quantity).toBe(10);
		await page.setViewportSize({ width: 390, height: 844 });
		await page.goto(`/schedules/programs/${saved.id}`);
		await expect(page.getByLabel('Cohesion / Variety', { exact: true })).toBeVisible();
		await page.screenshot({ path: 'test-results/similarity-program-mobile.png' });
	}
	finally {
		for (const id of ids.reverse()) {
			await page.request.delete(`/api/v1/programs/${id}`, { headers });
		}
	}
});

test('shows draft sample loading, populated and failed states, and saved list samples', async ({ page }) => {
	const headers = { 'x-moirai-csrf': await authenticateAdministrator(page) };
	const source = await (await page.request.post('/api/v1/programs', { headers, data: {
		name: 'Preview anchors', config: { type: 'content', source: { type: 'collection', libraryId: randomUUID(), itemIds: [randomUUID()] }, strategy: { type: 'sequential' } },
	} })).json();
	let savedId: string | undefined;
	let retried = false;
	let release: () => void = () => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const items = ['Sample Moon', 'Sample Sunshine'].map((title) => ({ id: randomUUID(), libraryId: randomUUID(), title, year: 2026, artworkUrl: null, availability: 'available' }));
	try {
		await page.route('**/api/v1/programs/similarity-retry', async (route) => {
			retried = true;
			await route.fulfill({ json: { queued: 1 } });
		});
		await page.route('**/api/v1/programs/similarity-preview', async (route) => {
			const config = route.request().postDataJSON();
			await gate;
			if (config.variety === 98 || config.variety === 97) {
				await route.fulfill({ json: { programId: randomUUID(), health: 'degraded', previewPending: config.variety === 98,
					sourceLabel: config.variety === 98 ? 'Preparing the exclusion for matching.' : 'No related items are ready for matching yet.',
					indexedItemCount: 2, availableItemCount: 0, previewItems: [] } });
				return;
			}
			if (config.variety === 96 && !retried) {
				await route.fulfill({ json: { programId: randomUUID(), health: 'degraded', sourceLabel: 'Preparation failed for one item.', failedEmbeddingCount: 1,
					indexedItemCount: 2, availableItemCount: 1, previewItems: items.slice(0, 1), matchingItemCount: 1, requestedItemCount: config.quantity } });
				return;
			}
			if (config.variety === 99) {
				await route.fulfill({ status: 500, json: { message: 'Sample preview unavailable' } });
				return;
			}
			await route.fulfill({ json: { programId: randomUUID(), health: 'ready', sourceLabel: 'Similar to Preview anchors',
				indexedItemCount: 2, availableItemCount: 2, matchingItemCount: 2, requestedItemCount: config.quantity, failedEmbeddingCount: 0, previewItems: items.slice(0, config.quantity), excludedPreviewItems: config.hardExclusions?.length ? [items[1]] : [] } });
		});
		await page.goto('/schedules/programs/new');
		await page.getByRole('radio', { name: /^Similar Items/u }).check();
		await page.getByPlaceholder('e.g. Evening Lineup').fill('Sample program');
		await page.getByLabel('Source Program', { exact: true }).selectOption(source.id);
		await expect(page.getByText('Finding sample matches…')).toBeVisible();
		await expect(page.getByText('No related items are ready for matching yet.')).toBeHidden();
		release();
		const editorSample = page.getByRole('dialog').getByRole('region', { name: 'Sample matches' });
		await expect(editorSample.getByRole('link')).toHaveCount(2);
		await expect(editorSample.getByText('2 related matches available; requested 20.')).toBeVisible();
		await editorSample.scrollIntoViewIfNeeded();
		await page.screenshot({ path: 'test-results/similarity-shortage.png' });
		await page.getByLabel('Quantity', { exact: true }).fill('1');
		await expect(editorSample.getByRole('link')).toHaveCount(1);
		await expect(editorSample.getByText(/related matches available/u)).toHaveCount(0);
		await page.getByLabel('Cohesion / Variety', { exact: true }).fill('96');
		await page.getByRole('button', { name: 'Retry preparation', exact: true }).click();
		await expect(page.getByText('1 preparation task queued for retry.')).toBeVisible();
		await expect(page.getByRole('button', { name: 'Retry preparation', exact: true })).toHaveCount(0);
		await expect(editorSample.getByRole('link')).toHaveCount(1);
		await page.getByLabel('Cohesion / Variety', { exact: true }).fill('98');
		await expect(editorSample.getByRole('status')).toHaveText('Preparing the exclusion for matching.');
		await expect(editorSample.locator('.similarity-sample-stage')).toHaveAttribute('aria-busy', 'true');
		await expect(editorSample.locator('.similarity-sample-dimmed')).toHaveAttribute('inert', '');
		await expect(editorSample.locator('.similarity-sample-placeholder')).toHaveCount(5);
		await editorSample.scrollIntoViewIfNeeded();
		await page.screenshot({ path: 'test-results/similarity-preview-preparing.png' });
		await page.getByLabel('Cohesion / Variety', { exact: true }).fill('97');
		await expect(editorSample.getByRole('status')).toHaveText('No related items are ready for matching yet.');
		await expect(editorSample.locator('.loading-spinner')).toHaveCount(0);
		await expect(editorSample.locator('.similarity-sample-stage')).toHaveAttribute('aria-busy', 'false');
		await page.screenshot({ path: 'test-results/similarity-preview-empty.png' });
		await page.getByLabel('Cohesion / Variety', { exact: true }).fill('99');
		await expect(page.getByRole('alert').filter({ hasText: 'Sample preview unavailable' })).toBeVisible();
		await page.getByLabel('Cohesion / Variety', { exact: true }).fill('35');
		await expect(editorSample.getByRole('link')).toHaveCount(1);
		await page.getByLabel('Exclusions', { exact: true }).fill('superhero movies');
		await page.getByLabel('Exclusions', { exact: true }).blur();
		await page.getByLabel('Exclusion strictness', { exact: true }).fill('70');
		await expect(page.getByRole('region', { name: 'Excluded matches', exact: true }).getByRole('link')).toHaveCount(1);
		const savedResponse = page.waitForResponse((response) => response.url().endsWith('/programs') && response.request().method() === 'POST');
		await page.getByRole('button', { name: 'Save', exact: true }).click();
		savedId = (await (await savedResponse).json()).id;
		await page.route('**/api/v1/scheduling/overview', async (route) => {
			const response = await route.fetch();
			const body = await response.json();
			const status = body.programStatuses.find((entry: { programId: string }) => entry.programId === savedId);
			if (status) {
				status.previewItems = items;
				status.previewPending = false;
				status.health = 'ready';
				status.matchingItemCount = 2;
				status.requestedItemCount = 5;
			}
			await route.fulfill({ response, json: body });
		});
		await page.goto('/schedules/programs');
		const row = page.locator('.program-row').filter({ has: page.getByRole('link', { name: 'Sample program', exact: true }) });
		await expect(row.getByRole('region', { name: 'Sample matches' }).getByRole('link')).toHaveCount(2);
		await expect(row.getByText('2 related matches available; requested 5.')).toBeVisible();
		await row.getByRole('link', { name: 'Sample program', exact: true }).click();
		await expect(editorSample.getByRole('link')).toHaveCount(1);
	}
	finally {
		release();
		if (savedId) {
			await page.request.delete(`/api/v1/programs/${savedId}`, { headers });
		}
		await page.request.delete(`/api/v1/programs/${source.id}`, { headers });
	}
});

test('protects and saves exclusion text typed immediately before Escape', async ({ page }) => {
	const headers = { 'x-moirai-csrf': await authenticateAdministrator(page) };
	const ids: string[] = [];
	try {
		const source = await (await page.request.post('/api/v1/programs', { headers, data: {
			name: 'Exclusion draft source', config: { type: 'content', source: { type: 'collection', libraryId: randomUUID(), itemIds: [randomUUID()] }, strategy: { type: 'sequential' } },
		} })).json();
		ids.push(source.id);
		const program = await (await page.request.post('/api/v1/programs', { headers, data: {
			name: 'Exclusion draft', config: { type: 'similarity', sourceProgramId: source.id, quantity: 3, variety: 35 },
		} })).json();
		ids.push(program.id);
		await page.goto(`/schedules/programs/${program.id}`);
		const exclusions = page.getByLabel('Exclusions', { exact: true });
		await exclusions.pressSequentially('superhero movies, romantic comedies, ');
		await expect(exclusions).toHaveValue('superhero movies, romantic comedies, ');
		await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
		await exclusions.press('Escape');
		await expect(page.getByText('Save this program before closing?')).toBeVisible();
		await page.getByRole('button', { name: 'Save Changes', exact: true }).click();
		await expect.poll(async () => (await (await page.request.get(`/api/v1/programs/${program.id}`)).json()).config.hardExclusions)
			.toEqual(['superhero movies', 'romantic comedies']);
	}
	finally {
		for (const id of ids.reverse()) {
			await page.request.delete(`/api/v1/programs/${id}`, { headers });
		}
	}
});

test('creates a Theme Program with library filters and preserves edits', async ({ page }) => {
	await mkdir('test-results/theme-media', { recursive: true });
	const headers = { 'x-moirai-csrf': await authenticateAdministrator(page) };
	const libraryResponse = await page.request.post('/api/v1/libraries', { headers, data: {
		name: 'Theme library', typeKey: 'movies', sourceType: 'on-disk', sourceConfig: { scanRoot: process.cwd() + '/test-results/theme-media' },
	} });
	expect(libraryResponse.ok(), await libraryResponse.text()).toBe(true);
	const library = await libraryResponse.json();
	let id: string | undefined;
	try {
		await page.goto('/schedules/programs/new');
		await page.getByRole('radio', { name: /^Theme/u }).check();
		await page.getByPlaceholder('e.g. Evening Lineup').fill('Space discovery');
		await page.getByLabel('Target library', { exact: true }).selectOption(library.id);
		await expect(page.getByLabel('Source Program', { exact: true })).toHaveCount(0);
		await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
		await page.getByRole('button', { name: 'Configure Filters' }).click();
		const filters = page.getByRole('dialog', { name: 'Filter media' });
		await filters.getByPlaceholder('Partial title').fill('Space');
		await filters.getByRole('button', { name: 'Apply Filters', exact: true }).click();
		await expect(page.getByRole('button', { name: 'Configure Filters' })).toBeFocused();
		await expect(page.getByLabel('Order by', { exact: true })).toHaveCount(0);
		await page.getByLabel('Theme', { exact: true }).fill('Space exploration and first contact');
		await page.getByLabel('Quantity', { exact: true }).fill('4');
		const savedResponse = page.waitForResponse((response) => response.url().endsWith('/programs') && response.request().method() === 'POST');
		await page.getByRole('button', { name: 'Save', exact: true }).click();
		const saved = await (await savedResponse).json();
		id = saved.id;
		expect(saved.config).toMatchObject({ type: 'theme', libraryId: library.id, theme: 'Space exploration and first contact', quantity: 4, filter: { name: 'Space' } });
		expect(saved.config.sourceProgramId).toBeUndefined();
		await page.goto(`/schedules/programs/${id}`);
		await expect(page.getByLabel('Theme', { exact: true })).toHaveValue(saved.config.theme);
		await expect(page.getByLabel('Target library', { exact: true })).toHaveValue(library.id);
		await page.getByRole('button', { name: 'Configure Filters' }).click();
		await expect(filters.getByPlaceholder('Partial title')).toHaveValue('Space');
		await filters.getByRole('button', { name: 'Close filters' }).click();
		await expect(filters).toHaveCount(0);
		await expect(page.getByRole('button', { name: 'Configure Filters' })).toBeFocused();
		await page.getByLabel('Theme', { exact: true }).fill('Ocean voyages');
		await page.getByRole('button', { name: 'Save', exact: true }).click();
		await expect.poll(async () => (await (await page.request.get(`/api/v1/programs/${id}`)).json()).config.theme).toBe('Ocean voyages');
		await page.goto('/schedules/programs?type=theme');
		await expect(page.getByRole('link', { name: 'Space discovery', exact: true })).toBeVisible();
	}
	finally {
		if (id) {
			await page.request.delete(`/api/v1/programs/${id}`, { headers });
		}
		await page.request.delete(`/api/v1/libraries/${library.id}`, { headers });
	}
});


test('saves and reopens optional Similar Items filters from the source library', async ({ page }) => {
	await mkdir('test-results/similarity-filter-media', { recursive: true });
	const headers = { 'x-moirai-csrf': await authenticateAdministrator(page) };
	const library = await (await page.request.post('/api/v1/libraries', { headers, data: {
		name: 'Similarity filter library', typeKey: 'movies', sourceType: 'on-disk', sourceConfig: { scanRoot: process.cwd() + '/test-results/similarity-filter-media' },
	} })).json();
	const source = await (await page.request.post('/api/v1/programs', { headers, data: {
		name: 'Filter anchors', config: { type: 'content', source: { type: 'collection', libraryId: library.id, itemIds: [randomUUID()] }, strategy: { type: 'sequential' } },
	} })).json();
	let id: string | undefined;
	try {
		await page.goto('/schedules/programs/new');
		await page.getByRole('radio', { name: /^Similar Items/u }).check();
		await page.getByPlaceholder('e.g. Evening Lineup').fill('Filtered recommendations');
		await page.getByLabel('Source Program', { exact: true }).selectOption(source.id);
		const disclosure = page.locator('.similarity-library-filters');
		await expect(disclosure).not.toHaveAttribute('open');
		await disclosure.locator('summary').click();
		await page.getByRole('button', { name: 'Configure Filters' }).click();
		const filters = page.getByRole('dialog', { name: 'Filter media' });
		await filters.getByPlaceholder('Partial title').fill('Night');
		await filters.getByRole('button', { name: 'Apply Filters', exact: true }).click();
		await expect(disclosure.locator('summary')).toContainText('Night');
		const response = page.waitForResponse((r) => r.url().endsWith('/programs') && r.request().method() === 'POST');
		await page.getByRole('button', { name: 'Save', exact: true }).click();
		const saved = await (await response).json();
		id = saved.id;
		expect(saved.config).toMatchObject({ type: 'similarity', sourceProgramId: source.id, filter: { name: 'Night' } });
		await page.goto(`/schedules/programs/${id}`);
		await expect(disclosure).not.toHaveAttribute('open');
		await expect(disclosure.locator('summary')).toContainText('Night');
		await disclosure.locator('summary').click();
		await page.getByRole('button', { name: 'Configure Filters' }).click();
		await expect(filters.getByPlaceholder('Partial title')).toHaveValue('Night');
	}
	finally {
		for (const programId of [id, source.id].filter(Boolean)) {
			await page.request.delete(`/api/v1/programs/${programId}`, { headers });
		}
		await page.request.delete(`/api/v1/libraries/${library.id}`, { headers });
	}
});
