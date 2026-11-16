import { expect, type Page } from '@playwright/test';
import { test } from './fixture';
import { seedLibrary, seedSchedule } from './seed';
import { seedSemanticCache } from './semantic';

/** Apply an Actor filter through the shared editor rather than injecting saved configuration. */
async function applyActor(page: Page): Promise<void> {
	await page.getByRole('button', { name: 'Configure Filters', exact: true }).click();
	const dialog = page.getByRole('dialog', { name: 'Filter media', exact: true });
	await dialog.getByRole('textbox', { name: 'Actor', exact: true }).fill('Alex Morgan');
	await dialog.getByRole('checkbox', { name: 'Top 10 only', exact: true }).check();
	await dialog.getByRole('button', { name: 'Apply Filters', exact: true }).click();
	await expect(dialog).toBeHidden();
}

test('persists top-billed Actor filters in Programs and similarity and applies them in Quick Setup', async ({ page, documentationServer }) => {
	const { libraryId, sequenceProgramIds } = await seedSchedule(page, documentationServer.directory);
	await page.goto('/schedules/programs/new');
	await page.getByPlaceholder('e.g. Primetime Movies').fill('Actor query');
	await page.getByRole('combobox', { name: 'Library', exact: true }).selectOption(libraryId);
	await expect(page.locator('.quick-query-carousel-item').first()).toBeVisible();
	await applyActor(page);
	await expect(page.getByText('Actor: Alex Morgan · Top 10', { exact: true })).toBeVisible();
	const createdQuery = page.waitForResponse(response => response.url().endsWith('/api/v1/programs') && response.request().method() === 'POST');
	await page.getByRole('button', { name: 'Add', exact: true }).click();
	const query = await (await createdQuery).json();
	expect(query.config.source).toMatchObject({ actor: 'Alex Morgan', actorTopBilledOnly: true });
	await expect(page).toHaveURL(`/schedules/programs/${query.id}`);
	await page.getByRole('button', { name: 'Close program editor', exact: true }).click();
	await expect(page.getByRole('dialog')).toBeHidden();
	await page.goto(`/schedules/programs/${query.id}`);
	await page.getByRole('button', { name: 'Configure Filters', exact: true }).click();
	await expect(page.getByRole('textbox', { name: 'Actor', exact: true })).toHaveValue('Alex Morgan');
	await expect(page.getByRole('checkbox', { name: 'Top 10 only', exact: true })).toBeChecked();
	await page.getByRole('button', { name: 'Cancel', exact: true }).click();
	await page.getByRole('button', { name: 'Close program editor', exact: true }).click();

	seedSemanticCache(documentationServer.directory);
	await page.goto('/schedules/programs/new');
	await page.getByRole('radio', { name: /^Similar Items/ }).check();
	await page.getByLabel('Source Program', { exact: true }).selectOption(sequenceProgramIds[1]!);
	await page.getByPlaceholder('e.g. Evening Lineup').fill('Actor similarity');
	await page.getByRole('button', { name: /^Additional filters/ }).click();
	await applyActor(page);
	const createdSimilarity = page.waitForResponse(response => response.url().endsWith('/api/v1/programs') && response.request().method() === 'POST');
	await page.getByRole('button', { name: 'Add', exact: true }).click();
	const similarity = await (await createdSimilarity).json();
	expect(similarity.config.filter).toMatchObject({ actor: 'Alex Morgan', actorTopBilledOnly: true });
	await expect(page).toHaveURL(`/schedules/programs/${similarity.id}`);
	await page.getByRole('button', { name: 'Close program editor', exact: true }).click();
	await expect(page.getByRole('dialog')).toBeHidden();
	await page.goto(`/schedules/programs/${similarity.id}`);
	await expect(page.getByRole('button', { name: /^Additional filters/ })).toContainText('Actor: Alex Morgan · Top 10');
	await page.getByRole('button', { name: 'Close program editor', exact: true }).click();

	await page.goto('/quick');
	await page.getByRole('button', { name: /Movie Channel/ }).click();
	await page.getByRole('combobox', { name: /^Library/ }).selectOption(libraryId);
	await page.locator('#quick-setup-actions').getByRole('button', { name: 'Continue', exact: true }).click();
	const preview = page.waitForRequest(request => request.url().endsWith('/quick-channel-setups/query-preview')
		&& request.postDataJSON()?.actor === 'Alex Morgan' && request.postDataJSON()?.actorTopBilledOnly === true);
	await applyActor(page);
	await preview;
	await expect(page.getByText('Actor: Alex Morgan · Top 10', { exact: true })).toBeVisible();
	await page.getByRole('button', { name: 'Configure Filters', exact: true }).click();
	await expect(page.getByRole('checkbox', { name: 'Top 10 only', exact: true })).toBeChecked();
});

for (const width of [390, 1440]) {
	test(`applies, restores and clears top-billed Actor filters at ${width}px`, async ({ page, documentationServer }) => {
		await page.setViewportSize({ width, height: 900 });
		const { libraryId } = await seedLibrary(page, documentationServer.directory);
		const trigger = page.getByRole('button', { name: 'Filter media', exact: true });
		await trigger.click();
		const dialog = page.getByRole('dialog', { name: 'Filter media', exact: true });
		const actor = dialog.getByRole('textbox', { name: 'Actor', exact: true });
		const toggle = dialog.getByRole('checkbox', { name: 'Top 10 only', exact: true });
		const apply = dialog.getByRole('button', { name: 'Apply Filters', exact: true });
		await expect(toggle).toBeDisabled();
		await expect(toggle).not.toBeChecked();
		await actor.fill('Alex Morgan');
		await expect(toggle).toBeEnabled();
		await toggle.focus();
		await page.keyboard.press('Space');
		await expect(toggle).toBeChecked();
		await actor.scrollIntoViewIfNeeded();
		await expect(actor).toBeInViewport();
		await expect(toggle).toBeInViewport();
		if (width > 390) {
			const actorBounds = await actor.boundingBox();
			const directorBounds = await dialog.getByRole('textbox', { name: 'Director', exact: true }).boundingBox();
			expect(Math.abs(actorBounds!.y - directorBounds!.y)).toBeLessThan(1);
		}
		const request = page.waitForRequest(request => {
			const url = new URL(request.url());
			return url.pathname === `/api/v1/libraries/${libraryId}/media` && url.searchParams.get('actor') === 'Alex Morgan'
				&& url.searchParams.get('actorTopBilledOnly') === 'true';
		});
		await apply.click();
		await request;
		await expect(page).toHaveURL(/actorTopBilledOnly=true/);
		await page.reload();
		await trigger.click();
		await expect(actor).toHaveValue('Alex Morgan');
		await expect(toggle).toBeChecked();
		await toggle.uncheck();
		await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
		await expect(dialog).toHaveCount(0);
		await expect(trigger).toBeFocused();
		await trigger.click();
		await expect(toggle).toBeChecked();
		await actor.fill('  ');
		await expect(toggle).toBeDisabled();
		await expect(toggle).not.toBeChecked();
		await actor.fill('Alex Morgan');
		await expect(toggle).not.toBeChecked();
		await apply.click();
		await expect.poll(() => new URL(page.url()).searchParams.has('actorTopBilledOnly')).toBe(false);
		await trigger.click();
		await toggle.check();
		await dialog.getByRole('button', { name: 'Clear All', exact: true }).click();
		await expect(actor).toHaveValue('');
		await expect(toggle).toBeDisabled();
		await expect(toggle).not.toBeChecked();
		await apply.click();
		await expect.poll(() => new URL(page.url()).searchParams.has('actor')).toBe(false);
	});
}
