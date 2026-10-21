import { expect, test } from '@playwright/test';
import { authenticateAdministrator } from './authentication';

test('animates Advanced and surrounding AI controls while preserving its draft and focus', async ({ page }) => {
	await authenticateAdministrator(page);
	await page.emulateMedia({ reducedMotion: 'no-preference' });
	await page.goto('/settings/ai');
	await expect(page.getByRole('combobox', { name: 'Provider', exact: true })).toBeVisible();
	const advanced = page.getByRole('button', { name: 'AI provider', exact: true });
	const content = page.locator('.ai-settings-advanced > .form-disclosure-content');
	const model = page.getByRole('textbox', { name: 'Custom model ID', exact: true });
	await expect(model).toBeHidden();
	await advanced.click();
	await expect(advanced).toHaveAttribute('aria-expanded', 'true');
	expect(await content.evaluate(element => element.getAnimations().some(animation => animation.playState === 'running'))).toBe(true);
	expect(await page.locator('.ai-settings-panel > .settings-actions').evaluate(element => element.getAnimations().some(animation => animation.playState === 'running'))).toBe(true);
	await model.fill('preserved-motion-draft');
	await advanced.click();
	await expect(model).toBeHidden();
	await expect(advanced).toBeFocused();
	await advanced.click();
	await expect(model).toHaveValue('preserved-motion-draft');
	await page.emulateMedia({ reducedMotion: 'reduce' });
	await advanced.click();
	await expect(model).toBeHidden();
	expect(await content.evaluate(element => element.getAnimations().length)).toBe(0);
	await page.keyboard.press('Enter');
	await expect(model).toBeVisible();
	expect(await content.evaluate(element => element.getAnimations().length)).toBe(0);
	for (const width of [1440, 390, 320]) {
		await page.setViewportSize({ width, height: 844 });
		await model.scrollIntoViewIfNeeded();
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
		await expect(page.getByRole('button', { name: 'Save AI Settings', exact: true })).toBeInViewport();
		await expect(model).toHaveValue('preserved-motion-draft');
		await page.screenshot({ path: `test-results/ai-advanced-${width}.png` });
	}
});

test('animates nested warning help and removes collapsed content from focus', async ({ page }) => {
	await authenticateAdministrator(page);
	await page.emulateMedia({ reducedMotion: 'no-preference' });
	await page.goto('/settings/playback');
	await page.getByRole('button', { name: /^Break budget warnings/ }).click();
	const help = page.getByRole('button', { name: 'How warnings work', exact: true });
	await help.click();
	const content = page.locator('.settings-help > .form-disclosure-content');
	await expect(content).toBeVisible();
	expect(await content.evaluate(element => element.getAnimations().some(animation => animation.playState === 'running'))).toBe(true);
	await help.click();
	await expect(content).toBeHidden();
	await expect(content).toHaveAttribute('inert', '');
	await expect(help).toBeFocused();
});
