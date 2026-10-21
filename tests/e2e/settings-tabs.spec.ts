import { expect, test } from '@playwright/test';
import { authenticateAdministrator } from './authentication';

test('retains independent settings drafts across keyboard tab switches and protects page departure', async ({ page }) => {
	await authenticateAdministrator(page);
	await page.goto('/settings');
	const playback = page.getByRole('tab', { name: /^Playback/ });
	const ai = page.getByRole('tab', { name: /^AI/ });
	const backups = page.getByRole('tab', { name: /^Backups/ });
	const capacity = page.getByRole('spinbutton', { name: /^Maximum active channel sessions/ });
	const saved = await capacity.inputValue();
	await capacity.fill(saved === '6' ? '7' : '6');
	await expect(playback).toHaveAccessibleName(/Unsaved changes/);
	await playback.focus();
	await page.keyboard.press('ArrowRight');
	await expect(ai).toBeFocused();
	await expect(ai).toHaveAttribute('aria-selected', 'true');
	await page.getByLabel('API Key', { exact: false }).fill('draft-key-for-tab-test');
	await expect(ai).toHaveAccessibleName(/Unsaved changes/);
	await ai.focus();
	await page.keyboard.press('End');
	await expect(backups).toBeFocused();
	await page.getByRole('button', { name: 'Automatic Backup', exact: true }).click();
	const interval = page.getByLabel('Backup interval (days)');
	const savedInterval = await interval.inputValue();
	await interval.fill(savedInterval === '3' ? '4' : '3');
	await expect(backups).toHaveAccessibleName(/Unsaved changes/);
	await backups.focus();
	await page.keyboard.press('ArrowRight');
	await expect(playback).toBeFocused();
	await expect(capacity).toHaveValue(saved === '6' ? '7' : '6');
	await page.getByRole('button', { name: 'Save Playback Settings', exact: true }).click();
	await expect(playback).not.toHaveAccessibleName(/Unsaved changes/);
	await expect(ai).toHaveAccessibleName(/Unsaved changes/);
	await expect(backups).toHaveAccessibleName(/Unsaved changes/);
	await page.getByRole('link', { name: 'Quick Setup', exact: true }).click();
	await expect(page.getByRole('alertdialog', { name: 'Discard Unsaved Changes?' })).toBeVisible();
	await page.getByRole('button', { name: 'Keep Editing', exact: true }).click();
	await ai.click();
	await expect(page.getByLabel('API Key', { exact: false })).toHaveValue('draft-key-for-tab-test');
	await page.getByRole('button', { name: 'Reset AI settings draft', exact: true }).click();
	await page.getByRole('button', { name: 'Confirm Reset AI settings draft', exact: true }).click();
	await expect(page.getByLabel('API Key', { exact: false })).toHaveValue('');
	await expect(ai).not.toHaveAccessibleName(/Unsaved changes/);
	await expect(backups).toHaveAccessibleName(/Unsaved changes/);
	await backups.click();
	await expect(interval).toHaveValue(savedInterval === '3' ? '4' : '3');
});

test('exposes hidden-tab failures and distinguishes pending playback data from saved summaries', async ({ page }) => {
	await authenticateAdministrator(page);
	let release!: () => void;
	const pending = new Promise<void>(resolve => {
		release = resolve;
	});
	await page.route('**/api/v1/playback/settings', async route => {
		await pending;
		await route.continue();
	});
	await page.route('**/api/v1/ai/settings', route => route.fulfill({ status: 503, json: { message: 'AI temporarily unavailable' } }));
	await page.route('**/api/v1/backups', route => route.fulfill({ status: 503, json: { message: 'Backup volume unavailable' } }));
	await page.goto('/settings');
	const warning = page.getByRole('button', { name: /^Break budget warnings/ });
	await expect(warning).toContainText('Loading…');
	await expect(warning).not.toContainText('80%');
	const ai = page.getByRole('tab', { name: /^AI/ });
	const backups = page.getByRole('tab', { name: /^Backups/ });
	await expect(ai).toHaveAccessibleName(/Needs attention/);
	await expect(backups).toHaveAccessibleName(/Needs attention/);
	release();
	await expect(warning).toContainText('Below');
	await ai.click();
	await expect(page.getByRole('tabpanel', { name: /^AI/ }).getByRole('alert')).toContainText('AI temporarily unavailable');
	await backups.click();
	await expect(page.getByRole('tabpanel', { name: /^Backups/ }).getByRole('alert')).toContainText('Backup volume unavailable');
	await expect(page.getByText('No saved backups yet.')).toBeHidden();
});

test('keeps collapsed playback drafts, keeps disclosure focus and fits narrow viewports with reduced motion', async ({ page }) => {
	await authenticateAdministrator(page);
	await page.emulateMedia({ reducedMotion: 'reduce' });
	await page.goto('/settings');
	const warning = page.getByRole('button', { name: /^Break budget warnings/ });
	await expect(warning).toHaveAttribute('aria-expanded', 'false');
	await expect(page.getByRole('slider')).toBeHidden();
	await warning.click();
	const slider = page.getByRole('slider');
	await slider.fill('45');
	await warning.click();
	await expect(slider).toBeHidden();
	await expect(warning).toBeFocused();
	await expect(warning).toContainText('Unsaved');
	await warning.click();
	await expect(slider).toHaveValue('45');
	await slider.focus();
	await page.getByRole('tab', { name: /^AI/ }).click();
	await page.getByRole('tab', { name: /^Playback/ }).click();
	await expect(slider).toHaveValue('45');
	await page.getByRole('button', { name: /^Global fallback filler/ }).click();
	await page.getByRole('button', { name: 'Engine details', exact: true }).click();
	for (const width of [320, 390, 1440]) {
		await page.setViewportSize({ width, height: 900 });
		await expect(page.getByRole('button', { name: 'Save Playback Settings' })).toBeInViewport();
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
	}
	await page.screenshot({ path: 'test-results/settings-tabs-desktop.png', fullPage: true });
	await page.getByRole('tab', { name: /^Backups/ }).click();
	await page.getByRole('button', { name: 'Automatic Backup', exact: true }).click();
	for (const width of [320, 390]) {
		await page.setViewportSize({ width, height: 844 });
		await expect(page.getByRole('button', { name: 'Save Backup Settings' })).toBeInViewport();
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
	}
	await page.screenshot({ path: 'test-results/settings-backups-mobile.png', fullPage: true });
});


test('keeps the automatic backup switch independent while one disclosure reveals all policy details', async ({ page }) => {
	await authenticateAdministrator(page);
	await page.goto('/settings');
	await page.getByRole('tab', { name: /^Backups/ }).click();
	const tab = page.getByRole('tabpanel', { name: /^Backups/ });
	const disclosure = tab.getByRole('button', { name: 'Automatic Backup', exact: true });
	const enabled = tab.getByRole('switch', { name: 'Enable automatic backups' });
	await expect(disclosure).toHaveAttribute('aria-expanded', 'false');
	await expect(tab.getByLabel('Backup interval (days)')).toBeHidden();
	const baselineEnabled = await enabled.isChecked();
	await enabled.setChecked(!baselineEnabled);
	await expect(disclosure).toHaveAttribute('aria-expanded', 'false');
	await expect(tab.getByRole('button', { name: 'Save Backup Settings' })).toBeEnabled();
	await disclosure.click();
	await expect(tab.getByLabel('Backup interval (days)')).toBeVisible();
	await expect(tab.getByLabel('Automatic backups to retain')).toBeVisible();
	await expect(tab.locator('.backup-details code')).toBeVisible();
	await tab.getByRole('button', { name: 'Reset Backup settings draft', exact: true }).click();
	await tab.getByRole('button', { name: 'Confirm Reset Backup settings draft', exact: true }).click();
	await expect(enabled).toBeChecked({ checked: baselineEnabled });
	await expect(disclosure).toHaveAttribute('aria-expanded', 'true');
	await disclosure.click();
	await expect(tab.getByLabel('Backup interval (days)')).toBeHidden();
	await expect(tab.getByRole('heading', { name: 'Backups', exact: true })).toBeVisible();
});

test('links Settings tabs and preserves drafts through tab history navigation', async ({ page }) => {
	await authenticateAdministrator(page);
	await page.goto('/settings?tab=ai&example=kept#details');
	await expect(page).toHaveURL(/\/settings\/ai\?example=kept#details$/);
	await expect(page.getByRole('tab', { name: /^AI/ })).toHaveAttribute('aria-selected', 'true');
	await page.getByRole('tab', { name: /^Backups/ }).click();
	await expect(page).toHaveURL(/\/settings\/backups\?example=kept#details$/);
	expect(new URL(page.url()).searchParams.get('example')).toBe('kept');
	expect(new URL(page.url()).hash).toBe('#details');
	await page.reload();
	await expect(page.getByRole('tab', { name: /^Backups/ })).toHaveAttribute('aria-selected', 'true');
	await page.goto('/settings?tab=unknown&example=kept');
	await expect(page).toHaveURL(/\/settings\/playback\?example=kept$/);
	await expect(page.getByRole('tab', { name: /^Playback/ })).toHaveAttribute('aria-selected', 'true');
	const capacity = page.getByRole('spinbutton', { name: /^Maximum active channel sessions/ });
	const saved = await capacity.inputValue();
	const changed = saved === '6' ? '7' : '6';
	await capacity.fill(changed);
	await page.getByRole('tab', { name: /^AI/ }).click();
	await expect(page).toHaveURL(/\/settings\/ai\?example=kept$/);
	await page.goBack();
	await expect(page.getByRole('tab', { name: /^Playback/ })).toHaveAttribute('aria-selected', 'true');
	await expect(capacity).toHaveValue(changed);
	await page.goForward();
	await expect(page.getByRole('tab', { name: /^AI/ })).toHaveAttribute('aria-selected', 'true');
	await expect(page.getByRole('alertdialog')).toHaveCount(0);
});

test('opens Settings section permalinks and supports native new-tab links', async ({ page, context }) => {
	await authenticateAdministrator(page);
	for (const [section, label] of [['playback', 'Playback'], ['ai', 'AI'], ['backups', 'Backups']]) {
		await page.goto(`/settings/${section}`);
		const tab = page.getByRole('tab', { name: new RegExp(`^${label}`) });
		await expect(tab).toHaveAttribute('aria-selected', 'true');
		await expect(tab).toHaveAttribute('href', `/settings/${section}`);
		await expect(page.locator('.primary-nav').getByRole('link', { name: 'Settings', exact: true })).toHaveAttribute('aria-current', 'page');
		await page.reload();
		await expect(tab).toHaveAttribute('aria-selected', 'true');
	}

	const ai = page.getByRole('tab', { name: /^AI/ });
	const opened = context.waitForEvent('page');
	await ai.click({ modifiers: [process.platform === 'darwin' ? 'Meta' : 'Control'] });
	const other = await opened;
	await expect(other).toHaveURL(/\/settings\/ai$/);
	await expect(other.getByRole('tab', { name: /^AI/ })).toHaveAttribute('aria-selected', 'true');
	await expect(page).toHaveURL(/\/settings\/backups$/);
	await other.close();
});

test('links XMLTV source tabs without reopening or clearing the editor draft', async ({ page }) => {
	await authenticateAdministrator(page);
	await page.goto('/playback/guide-templates');
	await page.getByRole('button', { name: 'Duplicate', exact: true }).first().click();
	const dialog = page.getByRole('dialog');
	await expect(dialog).toBeVisible();
	await expect(page).toHaveURL(/tab=channel/);
	await dialog.getByRole('tab', { name: 'Movie', exact: true }).click();
	await expect(page).toHaveURL(/tab=movie/);
	await page.reload();
	await expect(dialog.getByRole('tab', { name: 'Movie', exact: true })).toHaveAttribute('aria-selected', 'true');
	const source = dialog.getByRole('textbox', { name: 'Movie template (Liquid)', exact: true });
	await source.fill('<!-- retained movie draft -->');
	await dialog.getByRole('tab', { name: 'Episode', exact: true }).click();
	await expect(page).toHaveURL(/tab=episode/);
	await page.goBack();
	await expect(dialog.getByRole('tab', { name: 'Movie', exact: true })).toHaveAttribute('aria-selected', 'true');
	await expect(source).toHaveValue('<!-- retained movie draft -->');
	await page.goForward();
	await expect(dialog.getByRole('tab', { name: 'Episode', exact: true })).toHaveAttribute('aria-selected', 'true');
	await expect(page.getByRole('alertdialog')).toHaveCount(0);
});

test('sizes Engine details to its quick-look content and preserves dismissal', async ({ page }) => {
	await authenticateAdministrator(page);
	await page.route('**/api/v1/playback/status', async route => {
		const response = await route.fetch();
		await route.fulfill({ response, json: { ...await response.json(), engineVersion: 'ErsatzTV 26.10', contractRevision: '0123456789abcdef' } });
	});
	await page.goto('/settings/playback');
	const trigger = page.getByRole('button', { name: 'Engine details', exact: true });
	const popup = page.getByRole('tooltip');
	await expect(page.locator('.settings-status-title')).toBeVisible();
	for (const width of [1440, 390, 320]) {
		await page.setViewportSize({ width, height: 844 });
		const before = await page.locator('.settings-status').boundingBox();
		await trigger.click();
		await expect(popup).toBeVisible();
		await expect(popup).toContainText('ErsatzTV 26.10');
		await expect(popup).toContainText('0123456789ab');
		const bounds = await popup.boundingBox();
		expect(bounds!.height).toBeLessThan(160);
		expect(bounds!.x).toBeGreaterThanOrEqual(0);
		expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
		expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(844);
		expect(await page.locator('.settings-status').boundingBox()).toEqual(before);
		await page.screenshot({ path: `test-results/engine-details-${width}.png` });
		await page.keyboard.press('Escape');
		await expect(popup).toBeHidden();
		await expect(trigger).toBeFocused();
		await trigger.click();
		await page.getByRole('heading', { name: 'Settings', exact: true }).click();
		await expect(popup).toBeHidden();
	}

	// An already-open popup must not retain coordinates from the larger viewport.
	await page.setViewportSize({ width: 1440, height: 844 });
	await trigger.click();
	await expect(popup).toBeVisible();
	await page.setViewportSize({ width: 390, height: 844 });
	await expect(popup).toBeHidden();
	await expect(trigger).toHaveAttribute('aria-expanded', 'false');
	await trigger.click();
	await expect(popup).toBeInViewport();
	await page.setViewportSize({ width: 844, height: 390 });
	await expect(popup).toBeHidden();
	await expect(trigger).toHaveAttribute('aria-expanded', 'false');
	await trigger.click();
	await expect(popup).toBeInViewport();
	await page.keyboard.press('Escape');
	await expect(trigger).toBeFocused();
});


test('dismisses Engine details when the page or a nested container scrolls', async ({ page }) => {
	await authenticateAdministrator(page);
	await page.setViewportSize({ width: 1440, height: 600 });
	await page.goto('/settings/playback');
	await page.getByRole('button', { name: /^Global fallback filler/ }).click();
	const trigger = page.getByRole('button', { name: 'Engine details', exact: true });
	const popup = page.getByRole('tooltip');
	await trigger.click();
	await expect(popup).toBeVisible();
	const initialScroll = await page.evaluate(() => window.scrollY);
	await page.mouse.move(1000, 450);
	await page.mouse.wheel(0, 250);
	await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(initialScroll);
	await expect(popup).toBeHidden();
	await expect(trigger).toHaveAttribute('aria-expanded', 'false');
	await trigger.click();
	await expect(popup).toBeInViewport();

	// A nested scrolling ancestor emits non-bubbling events too.
	await page.keyboard.press('Escape');
	await page.addStyleTag({ content: '.app-content { height: 500px; overflow-y: auto; }' });
	await trigger.click();
	await expect(popup).toBeVisible();
	const scroller = page.locator('.app-content');
	const initialNestedScroll = await scroller.evaluate(element => element.scrollTop);
	await scroller.evaluate(element => {
		element.scrollTop += 200;
	});
	await expect.poll(() => scroller.evaluate(element => element.scrollTop)).toBeGreaterThan(initialNestedScroll);
	await expect(popup).toBeHidden();
	await expect(trigger).toHaveAttribute('aria-expanded', 'false');
	await trigger.click();
	await expect(popup).toBeInViewport();
	await page.keyboard.press('Escape');
	await expect(popup).toBeHidden();
	await expect(trigger).toBeFocused();
});
