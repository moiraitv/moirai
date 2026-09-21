import { mkdir } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { authenticateAdministrator } from './authentication';

test('preserves Library Query ordering and limit controls while semantic programs hide them', async ({ page }) => {
	await mkdir('test-results/query-controls-media', { recursive: true });
	const headers = { 'x-moirai-csrf': await authenticateAdministrator(page) };
	const response = await page.request.post('/api/v1/libraries', { headers, data: {
		name: 'Query controls library', typeKey: 'movies', sourceType: 'on-disk',
		sourceConfig: { scanRoot: process.cwd() + '/test-results/query-controls-media' },
	} });
	expect(response.ok()).toBe(true);
	const library = await response.json();
	let programId: string | undefined;
	try {
		await page.goto('/schedules/programs/new');
		await page.getByRole('combobox', { name: 'Library', exact: true }).selectOption(library.id);
		await page.getByPlaceholder('e.g. Primetime Movies').fill('Ordered library query');
		await expect(page.getByRole('combobox', { name: 'Order by', exact: true })).toHaveValue('name');
		await expect(page.getByRole('combobox', { name: 'Direction', exact: true })).toHaveValue('asc');
		await expect(page.getByRole('spinbutton', { name: 'Limit', exact: true })).toHaveValue('');
		await page.getByRole('combobox', { name: 'Order by', exact: true }).selectOption('release-date');
		await page.getByRole('combobox', { name: 'Direction', exact: true }).selectOption('desc');
		await page.getByRole('spinbutton', { name: 'Limit', exact: true }).fill('12');
		const savedResponse = page.waitForResponse((result) => result.url().endsWith('/programs') && result.request().method() === 'POST');
		await page.getByRole('button', { name: 'Save', exact: true }).click();
		const saved = await (await savedResponse).json();
		programId = saved.id;
		expect(saved.config.source).toMatchObject({ type: 'library-query', sort: { type: 'release-date', direction: 'desc' }, itemLimit: 12 });
		await page.goto(`/schedules/programs/${programId}`);
		await expect(page.getByRole('combobox', { name: 'Order by', exact: true })).toHaveValue('release-date');
		await expect(page.getByRole('combobox', { name: 'Direction', exact: true })).toHaveValue('desc');
		await expect(page.getByRole('spinbutton', { name: 'Limit', exact: true })).toHaveValue('12');

		await page.goto('/schedules/programs/new');
		await page.getByRole('radio', { name: /^Theme/u }).check();
		await expect(page.getByRole('combobox', { name: 'Order by', exact: true })).toHaveCount(0);
		await expect(page.getByRole('combobox', { name: 'Direction', exact: true })).toHaveCount(0);
		await expect(page.getByRole('spinbutton', { name: 'Limit', exact: true })).toHaveCount(0);

		await page.goto('/quick');
		await page.getByRole('button', { name: /Movie Channel/u }).click();
		await page.getByRole('combobox', { name: 'Library', exact: true }).selectOption(library.id);
		await page.locator('#quick-setup-actions').getByRole('button', { name: 'Continue', exact: true }).click();
		await expect(page.getByRole('combobox', { name: 'Order by', exact: true })).toHaveValue('name');
		await expect(page.getByRole('combobox', { name: 'Direction', exact: true })).toHaveValue('asc');
		await expect(page.getByRole('spinbutton', { name: 'Limit', exact: true })).toHaveValue('');
	}
	finally {
		if (programId) {
			await page.request.delete(`/api/v1/programs/${programId}`, { headers });
		}
		await page.request.delete(`/api/v1/libraries/${library.id}`, { headers });
	}
});
