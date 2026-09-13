import { expect, type Locator, type Page } from '@playwright/test';
import { test } from './documentation/fixture';
import { seedSchedule } from './documentation/seed';
import { authenticateAdministrator } from './authentication';

async function checkFocusBoundary(page: Page, dialog: Locator): Promise<void> {
	await expect.poll(() => dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true);
	await dialog.evaluate((node) => {
		const controls = [...node.querySelectorAll<HTMLElement>('button:enabled, input:enabled, select:enabled, textarea:enabled, a[href], [tabindex="0"]')]
			.filter((control) => control.tabIndex >= 0 && control.getClientRects().length && !control.closest('[inert]'));
		controls[0]!.dataset.focusBoundary = 'first';
		controls.at(-1)!.dataset.focusBoundary = 'last';
	});
	const first = dialog.locator('[data-focus-boundary="first"]');
	const last = dialog.locator('[data-focus-boundary="last"]');
	await first.focus();
	await page.keyboard.press('Shift+Tab');
	await expect(last).toBeFocused();
	await page.keyboard.press('Tab');
	await expect(first).toBeFocused();
}

for (const kind of ['program', 'template', 'channel', 'library', 'encoding', 'credit'] as const) {
	test(`contains ${kind} editor focus and protects its dirty draft on reload`, async ({ page, documentationServer }) => {
		const { program, template, libraryId } = await seedSchedule(page, documentationServer.directory);
		if (kind === 'program' || kind === 'template') {
			await page.goto(`/schedules/${kind}s/${kind === 'program' ? program.id : template.id}`);
		}
		else if (kind === 'channel') {
			await page.goto('/channels');
			await page.getByRole('button', { name: 'Edit Moonrise Classics', exact: true }).click();
		}
		else if (kind === 'library') {
			await page.goto(`/libraries/${libraryId}`);
			await page.getByRole('button', { name: 'Library settings', exact: true }).click();
		}
		else {
			await page.goto(`/playback/${kind === 'encoding' ? 'encoding-profiles' : 'credit-templates'}`);
			await page.getByRole('button', { name: 'Duplicate', exact: true }).first().click();
		}
		const dialog = page.getByRole('dialog').last();
		const name = dialog.getByRole('textbox', { name: kind === 'template' ? 'Template name' : /^Name/ }).first();
		await expect(name).toBeVisible();
		await checkFocusBoundary(page, dialog);
		await expect.poll(() => page.locator('.sidebar').evaluate((node) => Boolean(node.closest('[inert]')))).toBe(true);
		await name.fill('Protected draft');
		const warning = page.waitForEvent('dialog');
		const reload = page.reload({ timeout: 2_000 }).catch(() => null);
		const nativeDialog = await warning;
		expect(nativeDialog.type()).toBe('beforeunload');
		await nativeDialog.dismiss();
		await reload;
		await expect(name).toHaveValue('Protected draft');
		await page.keyboard.press('Escape');
		const confirmation = page.getByRole('alertdialog');
		await expect(confirmation).toBeVisible();
		await checkFocusBoundary(page, confirmation);
		await page.keyboard.press('Escape');
		await expect(confirmation).toBeHidden();
		await expect(name).toHaveValue('Protected draft');
	});
}

test('protects library creation and each independent Settings draft on navigation', async ({ page }) => {
	await authenticateAdministrator(page);
	await page.goto('/channels');
	await page.locator('.sidebar').getByRole('link', { name: 'Libraries', exact: true }).click();
	await page.getByRole('button', { name: 'Add Library', exact: true }).first().click();
	await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Unsaved library');
	await page.goBack();
	await page.getByRole('button', { name: 'Keep Editing', exact: true }).click();
	await expect(page.locator('.confirmation-modal-backdrop')).toHaveCount(0);
	await expect(page).toHaveURL(/\/libraries$/u);
	await expect(page.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('Unsaved library');
	await page.goBack();
	await page.getByRole('button', { name: 'Discard Changes', exact: true }).click();
	await expect(page).toHaveURL(/\/channels$/u);
	for (const section of ['capacity', 'preferences']) {
		await page.goto('/settings');
		if (section === 'capacity') {
			await page.getByLabel('Maximum active channel sessions').fill('9');
		}
		else {
			await page.locator('input[type="checkbox"]').first().uncheck();
		}
		await page.locator('.sidebar').getByRole('link', { name: 'Channels', exact: true }).click();
		await page.getByRole('button', { name: 'Keep Editing', exact: true }).click();
		await expect(page).toHaveURL(/\/settings$/u);
		await page.locator('.sidebar').getByRole('link', { name: 'Channels', exact: true }).click();
		await page.getByRole('button', { name: 'Discard Changes', exact: true }).click();
		await expect(page).toHaveURL(/\/channels$/u);
	}
});

test('isolates mobile navigation and releases it across breakpoint changes', async ({ page }) => {
	await authenticateAdministrator(page);
	await page.setViewportSize({ width: 390, height: 600 });
	await page.goto('/channels');
	const menu = page.getByRole('button', { name: 'Open navigation', exact: true });
	const sidebar = page.locator('.sidebar');
	await expect(sidebar).toHaveAttribute('inert');
	await menu.focus();
	await page.keyboard.press('Tab');
	expect(await sidebar.evaluate((node) => node.contains(document.activeElement))).toBe(false);
	await menu.click();
	await expect(sidebar.getByRole('button', { name: 'Close navigation', exact: true })).toBeFocused();
	await checkFocusBoundary(page, sidebar);
	await page.keyboard.press('Escape');
	await expect(menu).toBeFocused();
	await expect(sidebar).toHaveAttribute('inert');
	await menu.click();
	await page.setViewportSize({ width: 1440, height: 900 });
	await expect(sidebar).not.toHaveAttribute('inert');
	await expect(page.locator('main')).not.toHaveAttribute('inert');
	await page.setViewportSize({ width: 390, height: 600 });
	await expect(sidebar).toHaveAttribute('inert');
	expect(await sidebar.evaluate((node) => node.contains(document.activeElement))).toBe(false);
});

test('retains Settings drafts when sign-out is cancelled and warns for fallback uploads', async ({ page }) => {
	await authenticateAdministrator(page);
	await page.goto('/settings');
	await page.getByLabel('Maximum active channel sessions').fill('9');
	await page.getByRole('button', { name: 'Sign out', exact: true }).click();
	await page.getByRole('alertdialog').getByRole('button', { name: 'Cancel', exact: true }).click();
	await expect(page.getByLabel('Maximum active channel sessions')).toHaveValue('9');
	expect((await (await page.request.get('/api/v1/auth/session')).json()).status).toBe('authenticated');
	await page.getByLabel('Maximum active channel sessions').fill('4');
	await page.locator('.fallback-filler-panel input[type="file"]').setInputFiles({ name: 'fallback.mp4', mimeType: 'video/mp4', buffer: Buffer.from('disposable unsaved fixture') });
	await page.locator('.sidebar').getByRole('link', { name: 'Channels', exact: true }).click();
	await expect(page.getByRole('alertdialog')).toContainText('fallback filler');
	await page.getByRole('button', { name: 'Keep Editing', exact: true }).click();
	await expect(page.locator('.fallback-filler-panel')).toContainText('fallback.mp4');
});

test('does not warn when reloading read-only profiles or a saved program', async ({ page, documentationServer }) => {
	const { program } = await seedSchedule(page, documentationServer.directory);
	const warnings: string[] = [];
	page.on('dialog', async (dialog) => {
		warnings.push(dialog.type());
		await dialog.accept();
	});
	await page.goto('/playback/encoding-profiles');
	await page.getByRole('button', { name: 'View', exact: true }).first().click();
	await page.getByRole('button', { name: 'Close', exact: true }).focus();
	await page.reload();
	await page.goto(`/schedules/programs/${program.id}`);
	await page.getByRole('textbox', { name: /^Name/ }).fill('Saved program');
	await page.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(page.getByRole('dialog')).toBeHidden();
	await page.reload();
	expect(warnings).toEqual([]);
});

test('lets explicit library deletion leave a dirty editor without a second prompt', async ({ page, documentationServer }) => {
	const { libraryId } = await seedSchedule(page, documentationServer.directory);
	await page.goto(`/libraries/${libraryId}`);
	await page.getByRole('button', { name: 'Library settings', exact: true }).click();
	await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Unsaved rename');
	await page.getByRole('button', { name: 'Delete Library', exact: true }).click();
	const confirmation = page.getByRole('alertdialog');
	await confirmation.getByRole('textbox').fill('Evening Cinema');
	await confirmation.getByRole('button', { name: 'Delete Library', exact: true }).click();
	await expect(page).toHaveURL(/\/libraries$/u);
	await expect(page.getByRole('alertdialog')).toBeHidden();
});
