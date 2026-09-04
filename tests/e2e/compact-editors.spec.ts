import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { SECONDS_PER_SCHEDULING_DAY } from '@moirai/shared';
import { authenticateAdministrator } from './authentication';

type RequestHeaders = Record<string, string>;

async function contained(page: Page, element: Locator): Promise<void> {
	await expect(element).toBeVisible();
	await expect.poll(async () => {
		const box = await element.boundingBox();
		const viewport = page.viewportSize()!;
		return box !== null && box.y >= -1 && box.x >= -1
			&& box.y + box.height <= viewport.height + 1
			&& box.x + box.width <= viewport.width + 1;
	}).toBe(true);
}

async function authenticatedHeaders(page: Page): Promise<RequestHeaders> {
	return { 'x-moirai-csrf': await authenticateAdministrator(page) };
}

async function createLibrary(page: Page, headers: RequestHeaders, id: string): Promise<{
	id: string;
	mediaId: string;
}> {
	const directory = path.resolve(`test-results/runtime/compact-${id}`);
	await mkdir(directory, { recursive: true });
	await writeFile(path.join(directory, 'Compact.mp4'), 'fixture');
	const response = await page.request.post('/api/v1/libraries', {
		headers,
		data: {
			name: `Compact library ${id}`,
			typeKey: 'movies',
			sourceType: 'on-disk',
			sourceConfig: { scanRoot: directory },
		},
	});
	expect(response.ok(), await response.text()).toBe(true);
	const library = await response.json() as { id: string };
	await expect.poll(async () => {
		const detail = await (await page.request.get(`/api/v1/libraries/${library.id}`)).json();
		return detail.itemCount as number;
	}).toBe(1);
	const media = await (await page.request.get(`/api/v1/libraries/${library.id}/media`)).json() as {
		items: Array<{ id: string }>;
	};
	expect(media.items[0]).toBeDefined();
	return { id: library.id, mediaId: media.items[0]!.id };
}

async function createProgram(
	page: Page,
	headers: RequestHeaders,
	id: string,
	libraryId: string,
	mediaId: string,
): Promise<string> {
	const response = await page.request.post('/api/v1/programs', {
		headers,
		data: {
			name: `Compact program ${id}`,
			config: {
				type: 'content',
				source: { type: 'collection', libraryId, itemIds: [mediaId] },
				strategy: { type: 'sequential' },
			},
		},
	});
	expect(response.ok(), await response.text()).toBe(true);
	return ((await response.json()) as { id: string }).id;
}

async function createTemplate(
	page: Page,
	headers: RequestHeaders,
	id: string,
	programId: string | null = null,
): Promise<string> {
	const slotId = randomUUID();
	const response = await page.request.post('/api/v1/schedule-templates', {
		headers,
		data: {
			name: `Compact template ${id}`,
			slots: [{
				id: slotId,
				startSeconds: 0,
				programId,
				...(programId === null ? { filler: { mode: 'disabled' } } : {}),
			}],
			boundaries: [{
				id: randomUUID(),
				leftSlotId: slotId,
				rightSlotId: slotId,
				targetSeconds: SECONDS_PER_SCHEDULING_DAY,
				policy: 'hard',
			}],
		},
	});
	expect(response.ok(), await response.text()).toBe(true);
	return ((await response.json()) as { id: string }).id;
}

async function createChannel(
	page: Page,
	headers: RequestHeaders,
	id: string,
	logo?: string,
): Promise<{ id: string; name: string }> {
	const name = `Compact channel ${id}`;
	const response = await page.request.post('/api/v1/channels', {
		headers,
		data: {
			number: `98.${id.replaceAll('-', '').slice(0, 6)}`,
			name,
			...(logo ? { logo } : {}),
		},
	});
	expect(response.ok(), await response.text()).toBe(true);
	return { id: ((await response.json()) as { id: string }).id, name };
}

async function assignTemplate(
	page: Page,
	headers: RequestHeaders,
	channelId: string,
	templateId: string,
): Promise<void> {
	const response = await page.request.put(`/api/v1/channels/${channelId}/schedule`, {
		headers,
		data: { defaultTemplateId: templateId },
	});
	expect(response.ok(), await response.text()).toBe(true);
}

test('defaults existing program media browsing to collapsed and contains selection drawers', async ({ page }) => {
	test.setTimeout(90_000);
	const headers = await authenticatedHeaders(page);
	const id = randomUUID();
	const library = await createLibrary(page, headers, id);
	const programId = await createProgram(page, headers, id, library.id, library.mediaId);

	await page.goto('/schedules/programs/new');
	await page.getByLabel('Source type').selectOption('collection');
	await expect(page.getByRole('searchbox', { name: 'Search source media' })).toBeVisible();
	await page.goto(`/schedules/programs/${programId}`);
	const search = page.getByRole('searchbox', { name: 'Search source media' });
	await expect(search).toBeHidden();
	await expect(page.getByRole('button', { name: 'Review Selection' })).toBeEnabled();
	await page.locator('.source-browser-disclosure summary').click();
	await search.fill('Compact');
	await page.locator('.source-browser-disclosure summary').click();
	await expect(search).toBeHidden();
	await page.locator('.source-browser-disclosure summary').click();
	await expect(search).toHaveValue('Compact');

	for (const viewport of [
		{ width: 390, height: 844 },
		{ width: 844, height: 390 },
		{ width: 1440, height: 900 },
	]) {
		await page.setViewportSize(viewport);
		await contained(page, page.getByRole('dialog'));
		await contained(page, page.locator('.resource-editor-action-bar'));
		await page.getByRole('button', { name: 'Review Selection' }).click();
		await contained(page, page.getByRole('dialog', { name: 'Review selection' }));
		await contained(page, page.locator('.selection-drawer-footer'));
		await page.getByRole('button', { name: 'Close selection' }).click();
		await expect(page.locator('.selection-drawer-backdrop')).toHaveCount(0);
	}
});

test('keeps template and channel schedule editors contained on short viewports', async ({ page }) => {
	const headers = await authenticatedHeaders(page);
	const id = randomUUID();
	const templateId = await createTemplate(page, headers, id);
	const channel = await createChannel(page, headers, id);
	await assignTemplate(page, headers, channel.id, templateId);
	await page.setViewportSize({ width: 844, height: 390 });

	for (const url of [`/schedules/templates/${templateId}`, `/schedules/channels/${channel.id}`]) {
		await page.goto(url);
		await contained(page, page.getByRole('dialog'));
		await contained(page, page.locator('.resource-editor-header'));
		await contained(page, page.locator('.resource-editor-close'));
		await contained(page, page.locator('.resource-editor-action-bar'));
		const content = page.locator('.scheduling-workspace-content');
		await content.evaluate((element) => element.scrollTop = element.scrollHeight);
		expect(await content.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
		await contained(page, page.locator('.resource-editor-action-bar'));
	}
});

test('keeps acceleration and two-step logo draft actions usable in the channel editor', async ({ page }) => {
	const headers = await authenticatedHeaders(page);
	const id = randomUUID();
	const channel = await createChannel(page, headers, id, 'https://example.test/logo.svg');
	await page.route('https://example.test/logo.svg', (route) => route.fulfill({
		contentType: 'image/svg+xml',
		body: '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="green"/></svg>',
	}));
	await page.route('**/api/v1/playback/hardware-acceleration/predict', (route) => route.fulfill({
		json: { outcome: 'hardware', accel: 'videotoolbox', detail: 'Available for this format.' },
	}));

	await page.goto('/channels');
	await page.getByRole('button', { name: `Edit ${channel.name}`, exact: true }).click();
	await contained(page, page.getByRole('dialog'));
	await contained(page, page.locator('.resource-editor-action-bar'));
	const prediction = page.locator('.acceleration-prediction');
	await prediction.scrollIntoViewIfNeeded();
	await expect(prediction).toHaveText('VideoToolbox');
	await expect(prediction).toHaveCSS('position', 'static');
	await expect(prediction).toHaveCSS('margin-top', '0px');
	await expect(prediction.locator('..')).toHaveCSS('display', 'flex');
	const remove = page.getByRole('button', { name: 'Remove logo', exact: true });
	await remove.click();
	const confirm = page.getByRole('button', { name: 'Confirm remove logo', exact: true });
	await expect(confirm).toHaveText('');
	await expect(confirm.locator('svg')).toHaveClass(/lucide-check/);
	await page.keyboard.press('Escape');
	await expect(remove).toBeVisible();
	await remove.click();
	await confirm.click();
	await expect(remove).toBeHidden();
	expect((await (await page.request.get(`/api/v1/channels/${channel.id}`)).json()).logo).not.toBeNull();
	await page.getByRole('button', { name: 'Close channel editor' }).click();
	await contained(page, page.getByRole('alertdialog'));
	await page.getByRole('button', { name: 'Discard Changes' }).click();

	await expect(page.getByRole('alertdialog')).toBeHidden();
	await page.getByRole('button', { name: `Edit ${channel.name}`, exact: true }).click();
	await page.locator('input[type="file"][accept="image/*"]').setInputFiles({
		name: 'draft.svg',
		mimeType: 'image/svg+xml',
		buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="blue"/></svg>'),
	});
	await page.getByRole('button', { name: 'Remove selected logo', exact: true }).click();
	const removeSelected = page.getByRole('button', { name: 'Confirm remove selected logo', exact: true });
	await expect(removeSelected).toHaveText('');
	await removeSelected.click();
	await expect(page.locator('.channel-logo-workspace')).toHaveCount(0);
	await page.getByRole('button', { name: 'Close channel editor' }).click();
	await page.getByRole('button', { name: 'Discard Changes' }).click();
});

test('formats compact library timestamps and contains the filter dialog', async ({ page }) => {
	test.setTimeout(90_000);
	const headers = await authenticatedHeaders(page);
	const library = await createLibrary(page, headers, randomUUID());
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto(`/libraries/${library.id}`);
	await expect(page.locator('.status-last-scan strong')).not.toContainText(':');
	await expect(page.locator('.status-last-scan small')).toContainText(/\d+:\d+.*•/);
	await page.getByRole('button', { name: 'Filter media' }).click();
	await contained(page, page.getByRole('dialog'));
	await page.setViewportSize({ width: 844, height: 390 });
	await contained(page, page.getByRole('dialog'));
});

test('keeps incomplete schedule previews stable without repeated requests', async ({ page }) => {
	const headers = await authenticatedHeaders(page);
	const id = randomUUID();
	const templateId = await createTemplate(page, headers, id);
	const channel = await createChannel(page, headers, id);
	await assignTemplate(page, headers, channel.id, templateId);
	await page.clock.install({ time: new Date('2026-09-03T19:00:00Z') });
	let guideRequests = 0;
	await page.route('**/api/v1/schedule-guide?*', async (route) => {
		guideRequests += 1;
		const query = new URL(route.request().url()).searchParams;
		const capabilities = await (await page.request.get('/api/v1/capabilities')).json();
		await route.fulfill({
			json: {
				startDate: query.get('startDate'),
				days: 1,
				requestedDays: Number(query.get('days')),
				timeZone: capabilities.timeZone,
				segmentLimitApplied: true,
				channels: [],
			},
		});
	});
	await page.goto('/schedules/channels');
	const card = page.locator('.schedule-channel-card').filter({ hasText: channel.name });
	await expect(card.locator('.next-day')).toContainText('Preview incomplete');
	await page.clock.fastForward(180_000);
	await expect(card.locator('.next-day')).toContainText('Preview incomplete');
	expect(guideRequests).toBe(1);
});
