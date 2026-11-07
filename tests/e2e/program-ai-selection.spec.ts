import { randomUUID } from 'node:crypto';
import { expect, test, type WebSocketRoute } from '@playwright/test';
import { AI_GENERATION_TARGET_MS, type AiGeneration, type AiContentSelectionResponse, type ContentExclusions, type SelectedMediaSort } from '@moirai/shared';
import { authenticateAdministrator } from './authentication';

const libraryIds = [randomUUID(), randomUUID()];
const itemIds: string[] = Array.from({ length: 6 }, () => randomUUID());
const programId = randomUUID();
const program = {
	id: programId, name: 'AI fixture', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
	config: { type: 'content', source: { type: 'ai', libraryId: libraryIds[0], prompt: 'Original prompt',
		itemIds: [itemIds[0]], excludedItemIds: undefined as string[] | undefined, exclusions: undefined as ContentExclusions | undefined,
		sort: { type: 'date-added', direction: 'asc' } as SelectedMediaSort }, strategy: { type: 'sequential' } },
};
let jobs: Map<string, AiGeneration>;
let starts: number;
let requestedMaxResults: number | undefined;
let requestedExclusions: string[];
let cancelled: string[];
let result: AiContentSelectionResponse | undefined;
let saved: typeof program | undefined;
let reviewFailed: boolean;

/** Finish retained jobs without coupling their lifetime to the initiating browser page. */
function complete(): void {
	for (const [id, job] of jobs) {
		jobs.set(id, { ...job, state: 'completed', result: result ?? { itemIds, unmatched: [], catalogTruncated: false } });
	}
}

test.beforeEach(async ({ page }) => {
	jobs = new Map();
	starts = 0;
	requestedMaxResults = undefined;
	requestedExclusions = [];
	cancelled = [];
	result = undefined;
	saved = undefined;
	reviewFailed = false;
	await authenticateAdministrator(page);
	await page.route('**/api/v1/ai', route => route.fulfill({ json: { configured: true } }));
	await page.route('**/api/v1/ai/generations', async route => {
		const body = route.request().postDataJSON();
		starts += 1;
		requestedMaxResults = body.maxResults;
		requestedExclusions = body.exclusions?.itemIds ?? [];
		const job: AiGeneration = { id: body.id, startedAt: Date.now(), state: 'running', status: 'discovering' };
		jobs.set(body.id, job);
		if (result) {
			complete(); 
		}
		await route.fulfill({ status: 202, json: jobs.get(body.id) });
	});
	await page.route('**/api/v1/ai/generations/*', async route => {
		const id = route.request().url().split('/').at(-1)!;
		if (route.request().method() === 'DELETE') {
			cancelled.push(id);
			jobs.delete(id);
			await route.fulfill({ status: 204 });
		}
		else if (jobs.has(id)) {
			await route.fulfill({ json: jobs.get(id) });
		}
		else {
			await route.fulfill({ status: 404, json: { code: 'not_found', message: 'Generation expired or the server restarted. Generate again.' } });
		}
	});
	await page.route('**/api/v1/libraries', route => route.fulfill({ json: libraryIds.map((id, index) => ({
		id, name: `Library ${index + 1}`, typeKey: 'movies', enabled: true,
	})) }));
	await page.route('**/api/v1/libraries/*/genres*', route => route.fulfill({ json: [] }));
	await page.route('**/api/v1/libraries/*/media-source-options*', route => route.fulfill({ json: {
		entries: [], pagination: { page: 1, totalPages: 1, total: 0, pageSize: 20 },
	} }));
	await page.route('**/api/v1/scheduling/overview', route => route.fulfill({ json: {
		programs: [saved ?? program], templates: [], channelSchedules: [], programStatuses: [],
	} }));
	await page.route('**/api/v1/libraries/*/media-selection', route => reviewFailed
		? route.fulfill({ status: 503, json: { message: 'Unavailable' } })
		: route.fulfill({ json: route.request().postDataJSON().itemIds
			.map((id: string) => ({
				id, libraryId: libraryIds[0], title: `Result ${itemIds.indexOf(id) + 1}`, year: 2020, kind: 'movie',
				availability: 'available', artworkUrl: null, durationMs: 90_000,
				...(route.request().postDataJSON().exclusions?.itemIds.includes(id) ? { excluded: true } : {}),
			})) }));
	await page.route(`**/api/v1/programs/${programId}`, async route => {
		saved = { ...program, ...route.request().postDataJSON() };
		await route.fulfill({ json: saved });
	});
});

test('restores a pending draft after reload and applies its completed job without another paid start', async ({ page }) => {
	await page.goto(`/schedules/programs/${programId}`);
	await page.getByLabel('Prompt', { exact: true }).fill('Spaceship combat');
	await page.getByRole('slider', { name: /Results/ }).fill('200');
	await page.getByRole('button', { name: 'Generate', exact: true }).click();
	await expect.poll(() => starts).toBe(1);
	expect(requestedMaxResults).toBe(200);
	await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
	await page.reload();
	await expect(page.getByLabel('Prompt', { exact: true })).toHaveValue('Spaceship combat');
	await expect(page.getByRole('slider', { name: /Results/ })).toHaveValue('200');
	await expect(page.getByRole('status').filter({ hasText: 'Finding candidates' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
	complete();
	await expect(page.getByText('6 selected', { exact: true })).toBeVisible();
	expect(starts).toBe(1);
	await page.getByRole('button', { name: 'Save', exact: true }).click();
	await expect.poll(() => saved?.config.source.itemIds.length).toBe(6);
	expect(saved?.config.source.prompt).toBe('Spaceship combat');
	await page.goto(`/schedules/programs/${programId}`);
	await expect(page.getByRole('button', { name: 'Close', exact: true })).toBeVisible();
});

test('retains jobs when closing the editor and restores the result on reopening', async ({ page }) => {
	await page.goto(`/schedules/programs/${programId}`);
	await page.getByRole('button', { name: 'Generate', exact: true }).click();
	await expect.poll(() => starts).toBe(1);
	await page.getByRole('button', { name: 'Close program editor', exact: true }).click();
	await expect(page.getByRole('dialog')).toHaveCount(0);
	complete();
	await page.goto(`/schedules/programs/${programId}`);
	await expect(page.getByText('6 selected', { exact: true })).toBeVisible();
	expect(cancelled).toHaveLength(0);
	expect(starts).toBe(1);
});

test('warns before saving results generated from an earlier prompt', async ({ page }) => {
	await page.goto(`/schedules/programs/${programId}`);
	const prompt = page.getByLabel('Prompt', { exact: true });
	const warning = page.getByRole('status').filter({ hasText: 'This prompt has not been generated for the current selection.' });
	await expect(warning).toBeHidden();
	await prompt.fill('Revised prompt');
	await expect(warning).toBeVisible();
	await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
	await page.reload();
	await expect(warning).toBeVisible();
	result = { itemIds, unmatched: [], catalogTruncated: false };
	await page.getByRole('button', { name: 'Generate', exact: true }).click();
	await expect(page.getByText('6 selected', { exact: true })).toBeVisible();
	await expect(warning).toBeHidden();
	await prompt.fill('Another prompt');
	await expect(warning).toBeVisible();
	await page.getByRole('button', { name: 'Save', exact: true }).click();
	await expect.poll(() => saved?.config.source.prompt).toBe('Another prompt');
	expect(saved?.config.source.itemIds).toEqual(itemIds);
});

test('reset cancels pending generation and restores saved fields across reload', async ({ page }) => {
	await page.goto(`/schedules/programs/${programId}`);
	await page.getByLabel('Prompt', { exact: true }).fill('Changed prompt');
	await page.getByRole('button', { name: 'Generate', exact: true }).click();
	await expect.poll(() => starts).toBe(1);
	await page.getByRole('button', { name: 'Reset', exact: true }).click();
	await page.getByRole('button', { name: 'Confirm Reset', exact: true }).click();
	await expect.poll(() => cancelled.length).toBe(1);
	await page.reload();
	await expect(page.getByLabel('Prompt', { exact: true })).toHaveValue('Original prompt');
	await expect(page.getByText('1 selected', { exact: true })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Close', exact: true })).toBeVisible();
});

test('restores incomplete new drafts and clears results when changing libraries', async ({ page }) => {
	await page.goto('/schedules/programs/new');
	await page.getByLabel('Source type', { exact: true }).selectOption('ai');
	await page.getByRole('textbox', { name: /^Name/ }).fill('New AI draft');
	await page.reload();
	await expect(page.getByRole('textbox', { name: /^Name/ })).toHaveValue('New AI draft');
	await expect(page.getByLabel('Source type', { exact: true })).toHaveValue('ai');
	result = { itemIds, unmatched: [], catalogTruncated: false };
	await page.getByLabel('Prompt', { exact: true }).fill('Movies');
	await page.getByRole('button', { name: 'Generate', exact: true }).click();
	await expect(page.getByText('6 selected', { exact: true })).toBeVisible();
	await expect(page.getByText('No matches. Adjust the prompt and try again.')).toBeHidden();
	await page.getByLabel('Library', { exact: true }).selectOption(libraryIds[1]!);
	await expect(page.getByText('6 selected', { exact: true })).toBeHidden();
	await expect(page.getByRole('button', { name: 'Add', exact: true })).toBeDisabled();
});

test('expired jobs keep draft selections and require an explicit new generation', async ({ page }) => {
	await page.goto(`/schedules/programs/${programId}`);
	await page.getByLabel('Prompt', { exact: true }).fill('New prompt');
	await page.getByRole('button', { name: 'Generate', exact: true }).click();
	await expect.poll(() => starts).toBe(1);
	jobs.clear();
	await page.reload();
	await expect(page.getByRole('alert').filter({ hasText: 'expired' })).toBeVisible();
	await expect(page.getByText('1 selected', { exact: true })).toBeVisible();
	await expect(page.getByLabel('Prompt', { exact: true })).toHaveValue('New prompt');
	expect(starts).toBe(1);
});

test('reviews the full selection, retries loading, and saves exclusions', async ({ page }) => {
	result = { itemIds, unmatched: [], catalogTruncated: false };
	await page.goto(`/schedules/programs/${programId}`);
	await page.getByRole('button', { name: 'Generate', exact: true }).click();
	await expect(page.getByText('6 selected', { exact: true })).toBeVisible();
	reviewFailed = true;
	await page.getByRole('button', { name: 'Review results', exact: true }).click();
	const drawer = page.getByRole('dialog', { name: 'Manage exclusions', exact: true });
	await expect(drawer.getByRole('alert').filter({ hasText: 'Unavailable' })).toBeVisible();
	reviewFailed = false;
	await drawer.getByRole('button', { name: 'Try again' }).click();
	await expect(drawer.locator('.program-exclusions-list article')).toHaveCount(6);
	const exclude = drawer.getByRole('button', { name: 'Exclude Result 1', exact: true });
	const confirm = drawer.getByRole('button', { name: 'Confirm exclude Result 1', exact: true });
	await exclude.click();
	await expect(confirm).toBeFocused();
	await expect(drawer.locator('.program-exclusions-list article')).toHaveCount(6);
	await page.keyboard.press('Escape');
	await expect(exclude).toBeFocused();
	await exclude.click();
	await confirm.click();
	await expect(drawer.locator('.program-exclusions-list article')).toHaveCount(5);
	await drawer.getByRole('button', { name: 'Done', exact: true }).click();
	await page.reload();
	await expect(page.locator('.program-exclusions-summary')).toContainText('1 entry');
	await page.getByRole('button', { name: 'Save', exact: true }).click();
	await expect.poll(() => saved?.config.source).toMatchObject({
		itemIds, exclusions: { itemIds: [itemIds[0]], groupIds: [] },
	});
});

test('can save a restored legacy AI item that returns in a generation and is excluded again', async ({ page }) => {
	saved = { ...program, config: { ...program.config,
		source: { ...program.config.source, itemIds: itemIds.slice(1), excludedItemIds: [itemIds[0]!] } } };
	result = { itemIds, unmatched: [], catalogTruncated: false };
	await page.goto(`/schedules/programs/${programId}`);
	await page.getByRole('button', { name: 'Manage exclusions', exact: true }).click();
	const drawer = page.getByRole('dialog', { name: 'Manage exclusions', exact: true });
	await drawer.getByRole('tab', { name: 'Excluded (1)', exact: true }).click();
	await drawer.getByRole('button', { name: 'Restore Result 1', exact: true }).click();
	await drawer.getByRole('button', { name: 'Confirm restore Result 1', exact: true }).click();
	await drawer.getByRole('button', { name: 'Done', exact: true }).click();
	await page.getByRole('button', { name: 'Generate', exact: true }).click();
	await expect(page.getByText('6 selected', { exact: true })).toBeVisible();
	expect(requestedExclusions).toEqual([]);
	await page.getByRole('button', { name: 'Review results', exact: true }).click();
	await drawer.getByRole('button', { name: 'Exclude Result 1', exact: true }).click();
	await drawer.getByRole('button', { name: 'Confirm exclude Result 1', exact: true }).click();
	await drawer.getByRole('button', { name: 'Done', exact: true }).click();
	await page.getByRole('button', { name: 'Save', exact: true }).click();
	await expect.poll(() => saved?.config.source).toMatchObject({
		itemIds, excludedItemIds: [], exclusions: { itemIds: [itemIds[0]], groupIds: [] },
	});
});

test('keeps missing frozen results through bulk exclusion and removes them from manual order on confirmation', async ({ page }) => {
	const missing = randomUUID();
	const ids = [itemIds[2]!, missing, itemIds[1]!, itemIds[0]!];
	const exclusions = { itemIds: [itemIds[1]!], groupIds: [] };
	const sort = { type: 'manual' as const, itemIds: [itemIds[0]!, missing, itemIds[2]!, itemIds[1]!] };
	saved = { ...program, config: { ...program.config, source: { ...program.config.source, itemIds: ids, exclusions, sort } } };
	let resultReads = 0;
	await page.route('**/api/v1/libraries/*/media-selection', route => {
		resultReads += 1;
		const request = route.request().postDataJSON();
		return route.fulfill({ json: request.itemIds.filter((id: string) => id !== missing)
			.map((id: string) => ({ id, libraryId: libraryIds[0], title: `Result ${itemIds.indexOf(id) + 1}`,
				...(request.exclusions?.itemIds.includes(id) ? { excluded: true } : {}) })) });
	});
	await page.goto(`/schedules/programs/${programId}`);
	await page.getByRole('button', { name: 'Review results', exact: true }).click();
	const drawer = page.getByRole('dialog', { name: 'Manage exclusions', exact: true });
	const cards = drawer.locator('.program-exclusions-list article strong');
	await expect(cards).toHaveText(['Result 3', `Missing item · ${missing}`, 'Result 1']);
	await drawer.getByRole('button', { name: 'Exclude all results', exact: true }).click();
	await drawer.getByRole('button', { name: 'Confirm exclude all results', exact: true }).click();
	await expect(cards).toHaveText([`Missing item · ${missing}`]);
	await expect(drawer.getByRole('button', { name: 'Exclude all results', exact: true })).toBeDisabled();
	await drawer.getByRole('button', { name: `Remove Missing item · ${missing}`, exact: true }).click();
	await expect(cards).toHaveCount(1);
	await drawer.getByRole('button', { name: `Confirm remove Missing item · ${missing}`, exact: true }).click();
	await expect(drawer.getByText('No matching AI results.')).toBeVisible();
	expect(resultReads).toBe(1);
	await drawer.getByRole('button', { name: 'Done', exact: true }).click();
	await page.getByRole('button', { name: 'Save', exact: true }).click();
	await expect.poll(() => saved?.config.source).toMatchObject({
		itemIds: [itemIds[2], itemIds[1], itemIds[0]],
		sort: { type: 'manual', itemIds: [itemIds[0], itemIds[2], itemIds[1]] },
		exclusions: { itemIds: itemIds.slice(0, 3).sort(), groupIds: [] },
	});
});

test('returns to a populated browse page when a live scan removes the last page', async ({ page }) => {
	let socket: WebSocketRoute | undefined;
	await page.routeWebSocket('**/api/v1/events', connection => {
		socket = connection;
	});
	const items = Array.from({ length: 21 }, (_, index) => ({ id: randomUUID(), libraryId: libraryIds[0], title: `Browse result ${index + 1}`, kind: 'movie' }));
	let removed = false;
	let releasePage: () => void = () => {};
	const pendingPage = new Promise<void>(resolve => {
		releasePage = resolve;
	});
	await page.route('**/api/v1/libraries/*/media-source-options*', async route => {
		const page = Number(new URL(route.request().url()).searchParams.get('page') ?? 1);
		if (page === 2 && !removed) {
			await pendingPage;
		}
		const total = removed ? 20 : 21;
		return route.fulfill({ json: {
			entries: items.slice((page - 1) * 20, Math.min(page * 20, total)).map(item => ({ key: item.id, kind: 'item', item, matches: [] })),
			pagination: { page, total, totalPages: Math.ceil(total / 20), pageSize: 20 },
		} });
	});
	await page.goto(`/schedules/programs/${programId}`);
	await page.getByRole('button', { name: 'Manage exclusions', exact: true }).click();
	const drawer = page.getByRole('dialog', { name: 'Manage exclusions', exact: true });
	const pagination = drawer.getByRole('navigation', { name: 'Exclusions pagination' });
	const previous = pagination.getByRole('button', { name: 'Previous', exact: true });
	const next = pagination.getByRole('button', { name: 'Next', exact: true });
	await expect(previous).toBeDisabled();
	await drawer.getByRole('tabpanel').evaluate(panel => {
		panel.scrollTop = panel.scrollHeight;
	});
	await expect(next).toBeInViewport();
	await next.click();
	try {
		await expect(pagination).toContainText('Page 2 of 2');
		await expect(previous).toBeDisabled();
		await expect(next).toBeDisabled();
	}
	finally {
		releasePage();
	}
	await expect(drawer.getByRole('button', { name: 'Exclude Browse result 21', exact: true })).toBeVisible();
	await expect(previous).toBeEnabled();
	await expect(next).toBeDisabled();
	await expect.poll(() => drawer.getByRole('tabpanel').evaluate(panel => panel.scrollTop)).toBe(0);
	await expect.poll(() => Boolean(socket)).toBe(true);

	removed = true;
	const now = new Date().toISOString();
	socket!.send(JSON.stringify({ type: 'scan.changed', protocolVersion: 1, eventId: randomUUID(), occurredAt: now,
		data: { libraryId: libraryIds[0], scanId: randomUUID(), trigger: 'manual', status: 'complete', startedAt: now, completedAt: now,
			discoveredCount: 20, changedCount: 0, removedCount: 1, issueCount: 0, affectsProgramming: true } }));
	await expect(drawer.getByRole('button', { name: 'Exclude Browse result 1', exact: true })).toBeVisible();
	await expect(drawer.getByRole('button', { name: 'Exclude Browse result 21', exact: true })).toHaveCount(0);
	await expect(drawer.getByRole('button', { name: 'Previous', exact: true })).toHaveCount(0);
});

test('keeps Results and Excluded pagination in the drawer footer at desktop and phone widths', async ({ page }) => {
	const ids = Array.from({ length: 21 }, () => randomUUID());
	const excluded = Array.from({ length: 21 }, () => randomUUID());
	saved = { ...program, config: { ...program.config, source: { ...program.config.source, itemIds: ids, excludedItemIds: excluded } } };
	await page.emulateMedia({ reducedMotion: 'reduce' });
	await page.goto(`/schedules/programs/${programId}`);
	await page.getByRole('button', { name: 'Review results', exact: true }).click();
	const drawer = page.getByRole('dialog', { name: 'Manage exclusions', exact: true });
	const footer = drawer.locator('footer');
	const panel = drawer.getByRole('tabpanel');
	const pagination = footer.getByRole('navigation', { name: 'Exclusions pagination' });
	for (const name of ['Results', 'Excluded (21)']) {
		await drawer.getByRole('tab', { name, exact: true }).click();
		await expect(pagination).toContainText('Page 1 of 2');
		await expect(pagination.getByRole('button', { name: 'Next' })).toBeEnabled();
		for (const width of [1440, 390, 320]) {
			await page.setViewportSize({ width, height: 844 });
			await panel.evaluate(node => {
				node.scrollTop = 0;
			});
			await expect(footer).toBeInViewport();
			await expect(pagination.getByRole('button', { name: 'Next' })).toBeInViewport();
			const position = await footer.boundingBox();
			await panel.evaluate(node => {
				node.scrollTop = node.scrollHeight;
			});
			expect(await panel.evaluate(node => node.scrollTop)).toBeGreaterThan(0);
			expect(await footer.boundingBox()).toEqual(position);
			expect(await footer.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
			await expect(footer.getByRole('button', { name: 'Done' })).toBeInViewport();
			if (name === 'Results') {
				await expect(footer.getByRole('button', { name: 'Exclude all results' })).toBeInViewport();
			}
		}
		await pagination.getByRole('button', { name: 'Next' }).click();
		await expect(pagination).toContainText('Page 2 of 2');
		await expect(pagination.getByRole('button', { name: 'Previous' })).toBeEnabled();
	}
});

test('previews indexed exclusions by canonical ID on hover and keyboard focus', async ({ page }) => {
	const browse = { id: randomUUID(), title: 'Indexed browse item', kind: 'movie', year: 2025, artworkUrl: null };
	const group = { id: randomUUID(), title: 'Indexed group', kind: 'show', childCount: 1 };
	const missing = randomUUID();
	const alias = randomUUID();
	const canonical = randomUUID();
	const excluded = randomUUID();
	const excludedCanonical = randomUUID();
	saved = { ...program, config: { ...program.config, source: { ...program.config.source,
		itemIds: [alias, missing], excludedItemIds: [browse.id, excluded] } } };
	await page.route('**/api/v1/libraries/*/media-selection/aliases', route => route.fulfill({ json: { [excluded]: excludedCanonical } }));
	await page.route('**/api/v1/libraries/*/media-source-options*', route => route.fulfill({ json: {
		entries: [{ key: group.id, kind: 'group', group, matches: [] }, { key: browse.id, kind: 'item', item: browse, matches: [] }],
		pagination: { totalPages: 1 },
	} }));
	await page.route('**/api/v1/libraries/*/media-selection', route => route.fulfill({ json: route.request().postDataJSON().itemIds
		.filter((id: string) => id !== missing).map((id: string) => id === browse.id ? browse : ({ ...browse, id,
			canonicalId: id === alias ? canonical : excludedCanonical, title: id === alias ? 'Frozen multipart item' : 'Excluded multipart item' })) }));
	const previewIds: string[] = [];
	await page.route('**/api/v1/media/*/card-preview', route => {
		const id = route.request().url().split('/').at(-2)!;
		previewIds.push(id);
		return route.fulfill({ json: { id, title: 'Media preview', year: 2025, plot: `Indexed preview details for ${id}.`, artworkUrl: null,
			rating: null, primaryGenre: null, actors: [] } });
	});
	await page.goto(`/schedules/programs/${programId}`);
	await page.getByRole('button', { name: 'Manage exclusions' }).click();
	const drawer = page.getByRole('dialog', { name: 'Manage exclusions' });
	const tooltip = page.locator('.media-card-preview-tooltip');
	const groupRow = drawer.locator('article').filter({ hasText: group.title });
	await expect(groupRow.locator('..')).not.toHaveClass(/media-card-preview-trigger/);
	const browseRow = drawer.locator('article').filter({ hasText: browse.title });
	await expect(browseRow.getByRole('button', { name: `Excluded ${browse.title}` })).toBeDisabled();
	await browseRow.hover();
	await expect(tooltip.filter({ hasText: `Indexed preview details for ${browse.id}.` })).toBeVisible();
	await groupRow.hover();
	await expect(tooltip).toHaveCount(0);
	await groupRow.getByRole('button', { name: `Exclude ${group.title}` }).press('Tab');
	await expect(browseRow).toBeFocused();
	await expect(tooltip.filter({ hasText: `Indexed preview details for ${browse.id}.` })).toBeVisible();
	await drawer.getByRole('tab', { name: 'Results' }).click();
	await expect(drawer.locator('article').filter({ hasText: missing }).locator('..')).not.toHaveClass(/media-card-preview-trigger/);
	await drawer.getByRole('button', { name: 'Exclude Frozen multipart item' }).focus();
	await expect(tooltip.filter({ hasText: `Indexed preview details for ${canonical}.` })).toBeVisible();
	await drawer.getByRole('tab', { name: 'Excluded (2)' }).click();
	await drawer.getByRole('button', { name: 'Restore Excluded multipart item' }).focus();
	await expect(tooltip.filter({ hasText: `Indexed preview details for ${excludedCanonical}.` })).toBeVisible();
	await expect.poll(() => previewIds).toEqual([browse.id, canonical, excludedCanonical]);
});

test.describe('touch media previews', () => {
	test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

	test('opens an AI result preview without excluding the item', async ({ page }) => {
		await page.route('**/api/v1/media/*/card-preview', route => route.fulfill({ json: {
			id: itemIds[0], title: 'Result 1', year: 2020, plot: 'Touch preview details.', artworkUrl: null, rating: null, primaryGenre: null, actors: [],
		} }));
		await page.goto(`/schedules/programs/${programId}`);
		await page.getByRole('button', { name: 'Review results' }).tap();
		const drawer = page.getByRole('dialog', { name: 'Manage exclusions' });
		await drawer.getByRole('button', { name: 'Preview Result 1' }).tap();
		await expect(page.locator('.media-card-preview-tooltip')).toContainText('Touch preview details.');
		await expect(drawer.getByRole('tab', { name: 'Excluded (0)' })).toBeVisible();
	});
});

test('shows one exclusion for an indexed item and its saved multipart alias', async ({ page }) => {
	const canonicalId = itemIds[0]!;
	const absorbedId = randomUUID();
	const item = { id: canonicalId, libraryId: libraryIds[0], title: 'Multipart film', year: 2020, kind: 'movie', artworkUrl: null };
	saved = { ...program, config: { ...program.config,
		source: { ...program.config.source, itemIds: [], excludedItemIds: [canonicalId, absorbedId] } } };
	await page.route('**/api/v1/libraries/*/media-selection/aliases', route => route.fulfill({ json: { [absorbedId]: canonicalId } }));
	await page.route('**/api/v1/libraries/*/media-source-options*', route => route.fulfill({ json: {
		entries: [{ key: canonicalId, kind: 'item', item, matches: [] }], pagination: { page: 1, totalPages: 1 },
	} }));
	await page.route('**/api/v1/libraries/*/media-selection', route => route.fulfill({ json: route.request().postDataJSON().itemIds
		.map((id: string) => ({ ...item, id, ...(id === absorbedId ? { canonicalId } : {}) })) }));
	await page.goto(`/schedules/programs/${programId}`);
	await page.getByRole('button', { name: 'Manage exclusions', exact: true }).click();
	const drawer = page.getByRole('dialog', { name: 'Manage exclusions', exact: true });
	await expect(drawer.getByRole('button', { name: 'Excluded Multipart film' })).toBeDisabled();
	await drawer.getByRole('tab', { name: 'Excluded (1)', exact: true }).click();
	await expect(drawer.locator('.program-exclusions-list article')).toHaveCount(1);
	await drawer.getByRole('button', { name: 'Restore Multipart film', exact: true }).click();
	await drawer.getByRole('button', { name: 'Confirm restore Multipart film', exact: true }).click();
	await drawer.getByRole('tab', { name: 'Browse library' }).click();
	await expect(drawer.getByRole('button', { name: 'Exclude Multipart film', exact: true })).toBeEnabled();
	await drawer.getByRole('button', { name: 'Done', exact: true }).click();
	await page.getByRole('button', { name: 'Save', exact: true }).click();
	await expect.poll(() => saved?.config.source.excludedItemIds).toEqual([]);
});

test('shows retained progress, elapsed time and compact coverage on mobile', async ({ page }) => {
	await page.goto(`/schedules/programs/${programId}`);
	await page.getByRole('button', { name: 'Generate', exact: true }).click();
	await expect.poll(() => starts).toBe(1);
	for (const [id, job] of jobs) {
		jobs.set(id, { ...job, status: 'reviewing', batch: 1, totalBatches: 3 });
	}
	await expect(page.locator('.ai-selection-elapsed')).toContainText('15% estimated');
	for (const [id, job] of jobs) {
		jobs.set(id, { ...job, startedAt: Date.now() - AI_GENERATION_TARGET_MS / 2, status: 'reviewing', batch: 2, totalBatches: 3 }); 
	}
	await expect(page.getByRole('status').filter({ hasText: 'Reviewing candidates… · Batch 2 of 3' })).toBeVisible();
	await expect(page.locator('.ai-selection-elapsed')).toContainText('41% estimated');
	for (const [id, job] of jobs) {
		jobs.set(id, { ...job, startedAt: Date.now() - AI_GENERATION_TARGET_MS - 60_000 });
	}
	await expect(page.getByRole('status').filter({ hasText: 'Reviewing candidates… · Batch 2 of 3' })).toBeVisible();
	await expect(page.locator('.ai-selection-elapsed')).toContainText('41% estimated · 4:');
	for (const [id, job] of jobs) {
		jobs.set(id, { ...job, status: 'generating', batch: undefined, totalBatches: undefined });
	}
	await expect(page.locator('.ai-selection-elapsed')).toContainText('95% estimated');
	await page.reload();
	await expect(page.locator('.ai-selection-elapsed')).toContainText('95% estimated');
	await expect(page.getByRole('button', { name: 'Generate', exact: true })).toBeDisabled();
	await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeHidden();
	await page.setViewportSize({ width: 390, height: 844 });
	await page.locator('.ai-selection-progress').scrollIntoViewIfNeeded();
	const progressFitsButton = await page.locator('.ai-selection-progress').evaluate(progress => {
		const button = progress.parentElement!.querySelector('button')!;
		return progress.getBoundingClientRect().height <= button.getBoundingClientRect().height
			&& progress.scrollHeight <= progress.clientHeight;
	});
	expect(progressFitsButton).toBe(true);
	expect(await page.locator('.ai-selection-feedback').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
	await page.screenshot({ path: '/tmp/moirai-ai-progress-mobile.png' });
	result = { itemIds, unmatched: [], catalogTruncated: true, coverage: {
		libraryCount: 3000, reviewedCount: 1000, shortlistLimited: true, embeddingsAvailable: false,
		mediaEmbeddingsAvailable: true, queryEmbeddingsAvailable: false, searchBudgetExhausted: true,
		reviewStoppedEarly: true, finalReviewIncomplete: true,
	} };
	complete();
	await expect(page.getByText('6 selected · 1,000 of 3,000 reviewed')).toBeVisible();
	await expect(page.getByText('Some search concepts lacked local embeddings; title, plot, and metadata matching still ran.')).toBeVisible();
	await expect(page.getByText('Review stopped early. These matches came from completed batches; more titles may qualify.')).toBeVisible();
	await expect(page.getByText('Final refinement did not finish. These matches came from completed reviews and may need a closer look.')).toBeVisible();
	await expect(page.getByRole('status').filter({ hasText: '6 selected' })).toContainText('100%');
	await page.setViewportSize({ width: 390, height: 844 });
	await page.getByRole('button', { name: 'Generate', exact: true }).scrollIntoViewIfNeeded();
	const fits = await page.locator('.ai-selection-feedback').evaluate(element => element.scrollWidth <= element.clientWidth);
	expect(fits).toBe(true);
	await page.screenshot({ path: '/tmp/moirai-ai-draft-mobile.png' });
});


test('restores an excluded frozen result and sends the remaining exclusions to generation', async ({ page }) => {
	result = { itemIds, unmatched: [], catalogTruncated: false };
	await page.goto(`/schedules/programs/${programId}`);
	await page.getByRole('button', { name: 'Generate', exact: true }).click();
	await expect(page.getByText('6 selected', { exact: true })).toBeVisible();
	await page.getByRole('button', { name: 'Review results', exact: true }).click();
	const drawer = page.getByRole('dialog', { name: 'Manage exclusions', exact: true });
	await expect(drawer.locator('.program-exclusions-list article')).toHaveCount(itemIds.length);
	await drawer.getByRole('button', { name: 'Exclude all results', exact: true }).click();
	await drawer.getByRole('button', { name: 'Confirm exclude all results', exact: true }).click();
	await drawer.getByRole('tab', { name: 'Excluded (6)', exact: true }).click();
	await expect(drawer.locator('.program-exclusions-list article')).toHaveCount(6);
	await drawer.getByRole('button', { name: 'Restore Result 1', exact: true }).click();
	await drawer.getByRole('button', { name: 'Confirm restore Result 1', exact: true }).click();
	await expect(drawer.getByRole('tab', { name: 'Excluded (5)', exact: true })).toBeVisible();
	await drawer.getByRole('tab', { name: 'Results', exact: true }).click();
	await expect(drawer.getByText('1 matching result', { exact: true })).toBeVisible();
	await expect(drawer.locator('.program-exclusions-list article')).toContainText('Result 1');
	await drawer.getByRole('button', { name: 'Done', exact: true }).click();
	await page.getByRole('button', { name: 'Save', exact: true }).click();
	await expect.poll(() => saved?.config.source).toMatchObject({
		itemIds, exclusions: { itemIds: itemIds.slice(1).sort(), groupIds: [] },
	});
	await page.reload();
	await page.getByRole('button', { name: 'Review results', exact: true }).click();
	await drawer.getByRole('tab', { name: 'Excluded (5)', exact: true }).click();
	await expect(drawer.locator('.program-exclusions-list article')).toHaveCount(5);
	await drawer.press('Escape');
	await expect(drawer).toBeHidden();
	await expect(page.getByRole('button', { name: 'Review results', exact: true })).toBeFocused();
	await page.getByRole('button', { name: 'Generate', exact: true }).click();
	await expect(page.getByText('1 generated', { exact: true })).toBeVisible();
	expect(requestedExclusions).toEqual(itemIds.slice(1).sort());
});
