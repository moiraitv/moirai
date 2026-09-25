import { randomUUID } from 'node:crypto';
import { expect } from '@playwright/test';
import { test } from './fixture';
import { seedSchedule } from './seed';

test('saves all sequence ordering modes and resets ordering drafts', async ({ page, documentationServer }) => {
	const { sequenceProgramIds, requestHeaders } = await seedSchedule(page, documentationServer.directory);
	const response = await page.request.post('/api/v1/programs', { headers: requestHeaders, data: {
		name: 'Ordering fixture', config: { type: 'sequence', repeat: true, entries: sequenceProgramIds.map((programId, index) => ({ id: randomUUID(), programId, count: 3 - index })) },
	} });
	expect(response.ok()).toBe(true);
	const { id } = await response.json() as { id: string };
	for (const [type, label] of [['ordered', 'Ordered'], ['shuffled-blocks', 'Shuffled blocks'], ['shuffled-allocations', 'Shuffled allocations'], ['balanced-rotation', 'Balanced rotation']] as const) {
		await page.goto(`/schedules/programs/${id}`);
		await page.getByRole('button', { name: new RegExp(`^${label} `) }).click();
		const seed = page.getByRole('textbox', { name: 'Stable seed' });
		if (type.startsWith('shuffled')) {
			await seed.fill('browser-seed');
		}
		else {
			await expect(seed).toHaveCount(0);
		}
		await page.getByPlaceholder('e.g. Evening Lineup').fill(`Ordering fixture ${type}`);
		await page.getByRole('button', { name: 'Save', exact: true }).click();
		await expect(page).toHaveURL(/\/schedules\/programs(?:\?.*)?$/);
		await page.goto(`/schedules/programs/${id}`);
		await expect(page.getByRole('button', { name: new RegExp(`^${label} `) })).toHaveAttribute('aria-pressed', 'true');
		if (type.startsWith('shuffled')) {
			await expect(seed).toHaveValue('browser-seed');
		}
		const saved = await (await page.request.get(`/api/v1/programs/${id}`)).json();
		expect(saved.config.ordering.type).toBe(type);
	}
	await page.getByRole('button', { name: /^Shuffled blocks / }).click();
	await page.getByRole('button', { name: 'Reset', exact: true }).click();
	await page.getByRole('button', { name: 'Confirm Reset', exact: true }).click();
	await expect(page.getByRole('button', { name: /^Balanced rotation / })).toHaveAttribute('aria-pressed', 'true');
	await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
	await page.setViewportSize({ width: 390, height: 844 });
	await page.getByRole('button', { name: /^Shuffled allocations / }).scrollIntoViewIfNeeded();
	await expect(page.getByRole('button', { name: /^Shuffled allocations / })).toBeVisible();
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
