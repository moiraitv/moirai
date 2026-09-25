import { randomUUID } from 'node:crypto';
import { expect } from '@playwright/test';
import { test } from './fixture';
import { seedSchedule } from './seed';
import { captureSection } from './capture';

test('previews sequence drafts and saved guides without refreshing for a rename', { tag: '@docs-screenshot' }, async ({ page, documentationServer }) => {
	const { sequenceProgramIds, requestHeaders } = await seedSchedule(page, documentationServer.directory);
	const response = await page.request.post('/api/v1/programs', { headers: requestHeaders, data: {
		name: 'Sequence Guide', config: { type: 'sequence', repeat: true, ordering: { type: 'balanced-rotation' },
			entries: sequenceProgramIds.map((programId, index) => ({ id: randomUUID(), programId, count: 3 - index })) },
	} });
	expect(response.ok()).toBe(true);
	const { id } = await response.json() as { id: string };
	let requests = 0;
	page.on('request', request => {
		if (request.url().endsWith('/api/v1/programs/sequence-preview')) {
			requests += 1;
		}
	});
	await page.goto(`/schedules/programs/${id}`);
	const preview = page.getByRole('region', { name: 'Sequence guide preview', exact: true });
	await expect(preview.locator('.sequence-guide-segment').first()).toBeVisible();
	await expect(preview.getByRole('status')).toHaveCount(0);
	const initial = requests;
	await page.getByPlaceholder('e.g. Evening Lineup').fill('Renamed Sequence');
	await page.waitForTimeout(700);
	expect(requests).toBe(initial);
	const scroll = preview.locator('.sequence-guide-scroll');
	const day = preview.locator('.sequence-guide-day');
	const viewportWidth = (await scroll.boundingBox())!.width - 2;
	expect((await day.boundingBox())!.width / viewportWidth).toBeCloseTo(6, 1);
	await scroll.evaluate(element => {
		element.scrollLeft = 250; 
	});
	await page.getByRole('button', { name: /^Shuffled blocks / }).click();
	await expect.poll(() => requests).toBe(initial + 1);
	await expect(preview.getByRole('status')).toHaveCount(0);
	expect(await scroll.evaluate(element => element.scrollLeft)).toBe(250);
	const colors = await preview.locator('.sequence-guide-segment[data-entry-id]').evaluateAll(elements => {
		const colors = new Map<string, string>();
		for (const element of elements) {
			colors.set(element.getAttribute('data-entry-id')!, getComputedStyle(element).backgroundImage);
		}
		return [...colors.values()];
	});
	expect(new Set(colors).size).toBe(3);
	await scroll.evaluate(element => {
		element.scrollLeft = 0; 
	});
	await captureSection(page, preview, 'program-sequence-guide.png');
	await page.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(page).toHaveURL(/\/schedules\/programs(?:\?.*)?$/);
	await page.goto(`/schedules/programs?selected=${id}`);
	await expect(preview.locator('.sequence-guide-segment').first()).toBeVisible();
	await expect(preview.getByRole('status')).toHaveCount(0);
	await page.setViewportSize({ width: 390, height: 844 });
	await preview.scrollIntoViewIfNeeded();
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
	await scroll.evaluate(element => {
		element.scrollLeft = element.scrollWidth; 
	});
	expect(await scroll.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
});

test('creates and previews a Sequence without crypto.randomUUID', async ({ page, documentationServer }) => {
	const { sequenceProgramIds } = await seedSchedule(page, documentationServer.directory);
	await page.addInitScript(() => {
		Object.defineProperty(window.crypto, 'randomUUID', { value: undefined, configurable: true });
	});
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	page.on('console', message => {
		if (message.type() === 'error') {
			errors.push(message.text());
		}
	});
	await page.goto('/schedules/programs/new');
	await page.getByRole('radio', { name: /^Sequence/u }).check();
	await page.getByPlaceholder('e.g. Evening Lineup').fill('HTTP Sequence');
	await page.getByRole('button', { name: 'Add Step', exact: true }).click();
	await page.locator('.sequence-entry select').first().selectOption(sequenceProgramIds[0]!);
	await expect(page.locator('.sequence-guide-segment').first()).toBeAttached();
	await page.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(page).toHaveURL(/\/schedules\/programs(?:\?.*)?$/);
	await page.getByRole('button', { name: /^HTTP Sequence/ }).click();
	await expect(page.locator('.program-inspector .sequence-guide-segment').first()).toBeAttached();
	expect(errors).toEqual([]);
});
