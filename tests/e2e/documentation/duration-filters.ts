import { expect, type Page } from '@playwright/test';
import { test } from './fixture';
import { seedSchedule } from './seed';
import { seedSemanticCache } from './semantic';

async function applyDuration(page: Page): Promise<void> {
	await page.getByRole('button', { name: 'Configure Filters', exact: true }).click();
	const dialog = page.getByRole('dialog', { name: 'Filter media', exact: true });
	await dialog.getByRole('group', { name: 'Duration', exact: true }).getByRole('group', { name: 'From', exact: true }).getByRole('textbox', { name: 'Seconds', exact: true }).fill('0');
	await dialog.getByRole('group', { name: 'Duration', exact: true }).getByRole('group', { name: 'To', exact: true }).getByRole('textbox', { name: 'Hours', exact: true }).fill('25');
	await dialog.getByRole('button', { name: 'Apply Filters', exact: true }).click();
	await expect(dialog).toBeHidden();
}

test('persists duration bounds in programs and applies them in Quick Setup', async ({ page, documentationServer }) => {
	const { libraryId, sequenceProgramIds } = await seedSchedule(page, documentationServer.directory);
	await page.goto('/schedules/programs/new');
	await page.getByPlaceholder('e.g. Primetime Movies').fill('Duration query');
	await page.getByRole('combobox', { name: 'Library', exact: true }).selectOption(libraryId);
	await expect(page.locator('.quick-query-carousel-item').first()).toBeVisible();
	await applyDuration(page);
	await expect(page.getByText('Duration: 0h 0m 0s–25h 0m 0s', { exact: true })).toBeVisible();
	await page.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(page.getByRole('dialog')).toBeHidden();
	await page.getByRole('link', { name: 'Duration query', exact: true }).click();
	await page.getByRole('button', { name: 'Configure Filters', exact: true }).click();
	await expect(page.getByRole('group', { name: 'Duration', exact: true }).getByRole('group', { name: 'To', exact: true }).getByRole('textbox', { name: 'Hours', exact: true })).toHaveValue('25');
	await page.getByRole('button', { name: 'Cancel', exact: true }).click();
	await page.getByRole('button', { name: 'Close program editor', exact: true }).click();

	seedSemanticCache(documentationServer.directory);
	await page.goto('/schedules/programs/new');
	await page.getByRole('radio', { name: /^Similar Items/ }).check();
	await page.getByLabel('Source Program', { exact: true }).selectOption(sequenceProgramIds[1]!);
	await page.getByPlaceholder('e.g. Evening Lineup').fill('Duration similarity');
	await page.locator('.similarity-library-filters summary').click();
	await applyDuration(page);
	await page.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(page.getByRole('dialog')).toBeHidden();
	await page.getByRole('link', { name: 'Duration similarity', exact: true }).click();
	await expect(page.locator('.similarity-library-filters summary')).toContainText('Duration: 0h 0m 0s–25h 0m 0s');
	await page.getByRole('button', { name: 'Close program editor', exact: true }).click();

	await page.goto('/quick');
	await page.getByRole('button', { name: /Movie Channel/ }).click();
	await page.getByRole('combobox', { name: /^Library/ }).selectOption(libraryId);
	await page.locator('#quick-setup-actions').getByRole('button', { name: 'Continue', exact: true }).click();
	const preview = page.waitForRequest(request => request.url().endsWith('/quick-channel-setups/query-preview')
		&& request.postDataJSON()?.minimumDurationSeconds === 0 && request.postDataJSON()?.maximumDurationSeconds === 90000);
	await applyDuration(page);
	await preview;
	await expect(page.getByText('Duration: 0h 0m 0s–25h 0m 0s', { exact: true })).toBeVisible();
});
