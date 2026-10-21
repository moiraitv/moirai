import { expect } from '@playwright/test';
import { test } from './fixture';
import { authenticateAdministrator } from '../authentication';
import { capture } from './capture';

for (const section of [
	{ name: 'Filler', base: '/filler', initial: 'pre-rolls', labels: ['Pre-Rolls', 'Mid-Rolls', 'Post-Rolls', 'Tail Fillers'], paths: ['pre-rolls', 'mid-rolls', 'post-rolls', 'tail-fillers'], create: 'New Pre-Roll', dialog: 'New Pre-Roll', help: 'Pre-Rolls' },
	{ name: 'Playback', base: '/playback', initial: 'encoding-profiles', labels: ['Credit Templates', 'Encoding Profiles', 'Guide Templates'], paths: ['credit-templates', 'encoding-profiles', 'guide-templates'], create: 'New Profile', dialog: 'New Encoding Profile', help: 'Encoding Profiles' },
]) {
	test(`captures ${section.name} tabs and preserves collection navigation`, { tag: '@docs-screenshot' }, async ({ page }) => {
		await authenticateAdministrator(page);
		await page.goto(section.base);
		await expect(page).toHaveURL(`${section.base}/${section.initial}`);
		await expect(page.getByRole('heading', { name: section.name, exact: true })).toBeVisible();
		const navigation = page.locator('.sidebar');
		await expect(navigation.getByRole('link', { name: section.name, exact: true })).toHaveAttribute('aria-current', 'page');
		await expect(navigation.getByRole('link', { name: section.name, exact: true })).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
		await expect(navigation.getByRole('button', { name: `Toggle ${section.name.toLowerCase()} navigation` })).toHaveCount(0);
		const tabs = page.getByRole('navigation', { name: `${section.name} sections` });
		for (const [index, label] of section.labels.entries()) {
			await expect(navigation.getByRole('link', { name: label, exact: true })).toHaveCount(0);
			const tab = tabs.getByRole('link', { name: label, exact: true });
			await tab.click();
			await expect(page).toHaveURL(`${section.base}/${section.paths[index]}`);
			await expect(tab).toHaveAttribute('aria-current', 'page');
			await expect(tab).toBeFocused();
			await expect(tabs.locator('[aria-current="page"]')).toHaveCount(1);
			await expect(page.locator('article').first()).toBeVisible();
			await page.reload();
			await expect(tab).toHaveAttribute('aria-current', 'page');
		}
		await page.goBack();
		await expect(page).toHaveURL(`${section.base}/${section.paths.at(-2)}`);
		await page.goForward();
		await expect(page).toHaveURL(`${section.base}/${section.paths.at(-1)}`);

		// Existing editor URLs and retention remain independent of the collection navigation.
		await page.goto(`${section.base}/${section.initial}`);
		await page.getByRole('button', { name: section.create, exact: true }).click();
		const editor = page.getByRole('dialog', { name: section.dialog, exact: true });
		await expect(editor).toBeVisible();
		await expect(tabs.locator('[aria-current="page"]')).toHaveCount(1);
		await editor.getByRole('textbox', { name: 'Name', exact: true }).fill('Retained navigation draft');
		await page.goBack();
		await expect(editor).toBeHidden();
		await tabs.getByRole('link', { name: section.labels.at(-1)!, exact: true }).click();
		await page.goBack();
		await page.getByRole('button', { name: section.create, exact: true }).click();
		await expect(editor.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('Retained navigation draft');
		await page.keyboard.press('Escape');
		await expect(editor).toBeHidden();

		const help = page.getByRole('button', { name: `Help with ${section.help}`, exact: true });
		await expect(help).toBeVisible();
		const next = tabs.getByRole('link', { name: section.labels.at(-1)!, exact: true });
		const collectionUrl = page.url();
		const opened = page.context().waitForEvent('page');
		await next.click({ modifiers: ['ControlOrMeta'] });
		const otherPage = await opened;
		await expect(otherPage).toHaveURL(`${section.base}/${section.paths.at(-1)}`);
		await otherPage.close();
		await expect(page).toHaveURL(collectionUrl);
		await next.focus();
		await page.keyboard.press('Enter');
		await expect(next).toHaveAttribute('aria-current', 'page');
		await expect(next).toBeFocused();
		await page.keyboard.press('Shift+Tab');
		await expect(tabs.getByRole('link', { name: section.labels.at(-2)!, exact: true })).toBeFocused();
		await page.keyboard.press('Tab');
		await expect(next).toBeFocused();
		for (const width of [1440, 390, 320]) {
			await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
			await next.scrollIntoViewIfNeeded();
			await expect(next).toBeInViewport();
			expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
			expect(await next.evaluate(element => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
			await page.screenshot({ path: `test-results/management-${section.name.toLowerCase()}-${width}.png` });
		}
		await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
		const destination = navigation.getByRole('link', { name: section.name === 'Filler' ? 'Playback' : 'Filler', exact: true });
		await destination.click();
		await expect(navigation).not.toHaveClass(/sidebar-open/);
		await expect(page.getByRole('heading', { name: section.name === 'Filler' ? 'Playback' : 'Filler', exact: true })).toBeVisible();
		await page.goBack();
		await page.setViewportSize({ width: 1440, height: 900 });
		await page.mouse.move(1430, 890);
		await capture(page, `${section.name.toLowerCase()}-tabs.png`);
	});
}
