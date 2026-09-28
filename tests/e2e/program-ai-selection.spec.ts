import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { AI_GENERATION_TARGET_MS, type AiGeneration, type AiContentSelectionResponse } from '@moirai/shared';
import { authenticateAdministrator } from './authentication';

const libraryIds = [randomUUID(), randomUUID()];
const itemIds: string[] = Array.from({ length: 6 }, () => randomUUID());
const programId = randomUUID();
const program = {
	id: programId, name: 'AI fixture', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
	config: { type: 'content', source: { type: 'ai', libraryId: libraryIds[0], prompt: 'Original prompt',
		itemIds: [itemIds[0]], sort: { type: 'date-added', direction: 'asc' } }, strategy: { type: 'sequential' } },
};
let jobs: Map<string, AiGeneration>;
let starts: number;
let requestedMaxResults: number | undefined;
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
		: route.fulfill({ json: route.request().postDataJSON().itemIds.map((id: string) => ({
			id, libraryId: libraryIds[0], title: `Result ${itemIds.indexOf(id) + 1}`, year: 2020, kind: 'movie',
			availability: 'available', artworkUrl: null, durationMs: 90_000,
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
	await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
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
	await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
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
	await page.getByLabel('Library', { exact: true }).selectOption(libraryIds[1]!);
	await expect(page.getByText('6 selected', { exact: true })).toBeHidden();
	await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
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
	const drawer = page.getByRole('dialog', { name: 'Review results', exact: true });
	await expect(drawer.getByText('Could not load the selection.', { exact: false })).toBeVisible();
	reviewFailed = false;
	await drawer.getByRole('button', { name: 'Try again' }).click();
	await expect(drawer.locator('.selected-item-preview')).toHaveCount(6);
	await drawer.getByRole('button', { name: 'Exclude Result 1', exact: true }).click();
	await drawer.getByRole('button', { name: 'Confirm exclude Result 1', exact: true }).click();
	await expect(drawer.locator('.selected-item-preview')).toHaveCount(5);
	await drawer.getByRole('button', { name: 'Done', exact: true }).click();
	await page.reload();
	await expect(page.getByText('5 selected', { exact: true })).toBeVisible();
	await page.getByRole('button', { name: 'Save', exact: true }).click();
	await expect.poll(() => saved?.config.source.itemIds).toEqual(itemIds.slice(1));
});

test('shows retained progress, elapsed time and compact coverage on mobile', async ({ page }) => {
	await page.goto(`/schedules/programs/${programId}`);
	await page.getByRole('button', { name: 'Generate', exact: true }).click();
	await expect.poll(() => starts).toBe(1);
	for (const [id, job] of jobs) {
		jobs.set(id, { ...job, startedAt: Date.now() - AI_GENERATION_TARGET_MS / 2, status: 'reviewing', batch: 2, totalBatches: 3 }); 
	}
	await expect(page.getByRole('status').filter({ hasText: 'Reviewing candidates… · Batch 2 of 3' })).toBeVisible();
	await expect(page.locator('.ai-selection-elapsed')).toContainText('50% estimated');
	for (const [id, job] of jobs) {
		jobs.set(id, { ...job, startedAt: Date.now() - AI_GENERATION_TARGET_MS - 60_000 });
	}
	await expect(page.getByRole('status').filter({ hasText: 'Finishing review… · Batch 2 of 3' })).toBeVisible();
	await expect(page.locator('.ai-selection-elapsed')).toContainText('99% estimated · 4:');
	await page.reload();
	await expect(page.locator('.ai-selection-elapsed')).toContainText('99% estimated');
	await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
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
	} };
	complete();
	await expect(page.getByText('6 selected · 1,000 of 3,000 reviewed')).toBeVisible();
	await expect(page.getByText('Some search concepts lacked local embeddings; title, plot, and metadata matching still ran.')).toBeVisible();
	await expect(page.getByRole('status').filter({ hasText: '6 selected' })).toContainText('100%');
	await page.setViewportSize({ width: 390, height: 844 });
	await page.getByRole('button', { name: 'Generate', exact: true }).scrollIntoViewIfNeeded();
	const fits = await page.locator('.ai-selection-feedback').evaluate(element => element.scrollWidth <= element.clientWidth);
	expect(fits).toBe(true);
	await page.screenshot({ path: '/tmp/moirai-ai-draft-mobile.png' });
});
