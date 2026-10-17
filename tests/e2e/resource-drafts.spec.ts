import { expect, type Locator } from '@playwright/test';
import sharp from 'sharp';
import { test } from './documentation/fixture';
import { authenticateAdministrator } from './authentication';
import { seedSchedule } from './documentation/seed';

test.use({ actionTimeout: 15_000 });

async function reset(editor: Locator): Promise<void> {
	await editor.getByRole('button', { name: 'Reset', exact: true }).click();
	await editor.getByRole('button', { name: 'Confirm Reset', exact: true }).click();
}

for (const collection of ['encoding-profiles', 'credit-templates', 'guide-templates', 'pre-rolls', 'mid-rolls', 'post-rolls', 'tail-fillers']) {
	test(`adds ${collection} once, stays open, and saves further edits`, async ({ page }) => {
		await authenticateAdministrator(page);
		const base = `${collection.endsWith('templates') || collection === 'encoding-profiles' ? '/playback' : '/filler'}/${collection}`;
		await page.goto(`${base}/new`);
		const editor = page.getByRole('dialog').last();
		const name = editor.getByRole('textbox', { name: 'Name', exact: true });
		const restoredNotice = editor.getByRole('status').filter({ hasText: 'Previous draft restored' });
		await expect(restoredNotice).toHaveCount(0);
		await expect(editor.getByRole('button', { name: 'Add', exact: true })).toBeEnabled();
		await name.fill('  Retained new resource  ');
		await page.reload();
		await expect(name).toHaveValue('  Retained new resource  ');
		await expect(restoredNotice).toBeVisible();
		await restoredNotice.getByRole('button', { name: 'Dismiss notification' }).click();
		await expect(restoredNotice).toHaveCount(0);
		await editor.getByRole('button', { name: 'Add', exact: true }).click();
		await expect(editor.getByRole('button', { name: 'Close', exact: true })).toBeEnabled();
		await expect(name).toHaveValue('Retained new resource');
		await expect(page).not.toHaveURL(`${base}/new`);
		const savedUrl = page.url();
		await name.fill('Further changes');
		await editor.getByRole('button', { name: 'Save', exact: true }).click();
		await expect(editor.getByRole('button', { name: 'Close', exact: true })).toHaveClass(/secondary/);
		await expect(page).toHaveURL(savedUrl);
		await name.fill('Discard only this draft');
		await reset(editor);
		await expect(name).toHaveValue('Further changes');
		await page.reload();
		await expect(name).toHaveValue('Further changes');
		await editor.getByRole('button', { name: 'Close', exact: true }).click();
		await expect(page).toHaveURL(base);
		await expect(editor).toHaveCount(0);
	});
}

test('retains Programs, Templates, and channel Schedules through reload and explicit saves', async ({ page, documentationServer }) => {
	const { channel, sequenceProgramIds, template } = await seedSchedule(page, documentationServer.directory);
	for (const [url, label] of [
		[`/schedules/programs/${sequenceProgramIds[0]}`, 'Name'],
		[`/schedules/templates/${template.id}`, 'Template name'],
	]) {
		await page.goto(url!);
		const editor = page.getByRole('dialog').last();
		const name = editor.getByRole('textbox', { name: new RegExp(`^${label}`) });
		await expect(editor.getByRole('button', { name: 'Close', exact: true })).toBeEnabled();
		await expect(editor.getByRole('status').filter({ hasText: 'Previous draft restored' })).toHaveCount(0);
		await name.fill('Retained scheduling draft');
		await page.reload();
		await expect(name).toHaveValue('Retained scheduling draft');
		await expect(editor.getByRole('status').filter({ hasText: 'Previous draft restored' })).toBeVisible();
		await editor.getByRole('button', { name: 'Save', exact: true }).click();
		await expect(editor.getByRole('button', { name: 'Close', exact: true })).toBeEnabled();
		await expect(page).toHaveURL(url!);
	}
	await page.goto(`/schedules/channels/${channel.id}`);
	const editor = page.getByRole('dialog').last();
	const layers = editor.locator('.schedule-layer.conditional');
	const count = (await layers.count()) + 1;
	await editor.getByRole('button', { name: 'Add Conditional Template', exact: true }).click();
	await expect(layers).toHaveCount(count);
	await page.reload();
	await expect(layers).toHaveCount(count);
	await expect(editor.getByRole('status').filter({ hasText: 'Previous draft restored' })).toBeVisible();
	await editor.getByRole('button', { name: /^(?:Add|Save)$/u }).click();
	await expect(editor.getByRole('button', { name: 'Close', exact: true })).toBeEnabled();
	await expect(page).toHaveURL(`/schedules/channels/${channel.id}`);
});

test('dismisses the restored-draft notification automatically and keeps later saves distinct', async ({ page }) => {
	await authenticateAdministrator(page);
	await page.clock.install();
	await page.goto('/playback/credit-templates/new');
	const editor = page.getByRole('dialog').last();
	const name = editor.getByRole('textbox', { name: 'Name', exact: true });
	await name.fill('Retained notice');
	await page.reload();
	await expect(name).toHaveValue('Retained notice');
	const notice = editor.getByRole('status').filter({ hasText: 'Previous draft restored' });
	await expect(notice).toBeVisible();
	await page.clock.fastForward(6000);
	await expect(notice).toHaveCount(0);
	await name.fill('Still editing');
	await expect(notice).toHaveCount(0);
	await editor.getByRole('button', { name: 'Add', exact: true }).click();
	await expect(editor.getByRole('status').filter({ hasText: 'Credit Template saved.' })).toBeVisible();
	await expect(notice).toHaveCount(0);
});

test('protects pending changes with a prompt only when browser storage fails', async ({ page }) => {
	await authenticateAdministrator(page);
	await page.goto('/playback/credit-templates/new');
	const editor = page.getByRole('dialog').last();
	await editor.getByRole('textbox', { name: 'Name', exact: true }).fill('Recoverable');
	await page.evaluate(() => {
		Storage.prototype.setItem = () => {
			throw new Error('Storage unavailable'); 
		};
	});
	await editor.getByRole('textbox', { name: 'Name', exact: true }).fill('Keep this editor open');
	await expect(editor.getByRole('alert')).toContainText('could not be retained');
	await editor.locator('.resource-editor-close').click();
	await page.getByRole('alertdialog').getByRole('button', { name: 'Cancel', exact: true }).click();
	await expect(editor.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('Keep this editor open');
	await editor.locator('.resource-editor-close').click();
	await page.getByRole('alertdialog').getByRole('button', { name: 'Discard Changes', exact: true }).click();
	await expect(editor).toHaveCount(0);
});

test('finishes the requested history navigation after saving with failed browser retention', async ({ page, documentationServer }) => {
	test.setTimeout(150_000);
	const { mediaRoot } = await seedSchedule(page, documentationServer.directory);
	for (const [base, opener, role] of [
		['/schedules/programs', 'New Program', 'link'],
		['/schedules/templates', 'New Template', 'link'],
		['/playback/encoding-profiles', 'New Profile', 'button'],
		['/playback/credit-templates', 'New template', 'button'],
		['/playback/guide-templates', 'New template', 'button'],
		['/filler/pre-rolls', 'New Pre-Roll', 'button'],
		['/filler/mid-rolls', 'New Mid-Roll', 'button'],
		['/filler/post-rolls', 'New Post-Roll', 'button'],
		['/filler/tail-fillers', 'New Tail Filler', 'button'],
		['/libraries', 'Add Library', 'button'],
	] as const) {
		await page.goto(base);
		await page.getByRole(role, { name: opener, exact: true }).first().click();
		const editor = page.getByRole('dialog').last();
		await page.evaluate(() => {
			Storage.prototype.setItem = () => {
				throw new Error('Storage unavailable');
			};
		});
		const name = editor.getByRole('textbox', { name: /^(?:Name|Template name)(?:\s|$)/u });
		await name.fill(`Save before leaving ${base}`);
		if (base === '/libraries') {
			await editor.getByRole('textbox', { name: 'Path Moirai scans', exact: true }).fill(mediaRoot);
		}
		await expect(editor.getByRole('alert')).toContainText('could not be retained');
		const saved = page.waitForResponse(response => response.request().method() === 'POST'
			&& response.status() === 201 && !response.url().includes('preview'));
		const navigation = page.goBack();
		await page.getByRole('alertdialog').getByRole('button', { name: 'Save Changes', exact: true }).click();
		await saved;
		await navigation;
		await expect(page).toHaveURL(base);
		await expect(page.getByRole('dialog')).toHaveCount(0);
	}
});

test('retains selected channel logo, crop, and fallback video in actual browser storage', async ({ page, documentationServer }) => {
	const { channel } = await seedSchedule(page, documentationServer.directory);
	await page.goto(`/channels/${channel.id}`);
	const editor = page.getByRole('dialog').last();
	const png = await sharp({ create: { width: 160, height: 90, channels: 3, background: '#37678c' } }).png().toBuffer();
	await editor.locator('.channel-logo-editor input[type=file]').setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: png });
	await expect(editor.getByLabel('Channel logo crop preview')).toBeVisible();
	await editor.getByRole('button', { name: /Channel fallback override/ }).click();
	await editor.locator('.fallback-filler-editor input[type=file]').setInputFiles({ name: 'pending.mp4', mimeType: 'video/mp4', buffer: Buffer.from('video draft bytes') });
	await expect(editor.getByText('pending.mp4', { exact: true })).toBeVisible();
	await editor.getByRole('button', { name: 'Close channel editor', exact: true }).click();
	await expect(editor).toHaveCount(0);
	await page.goto(`/channels/${channel.id}`);
	await expect(editor.getByLabel('Channel logo crop preview')).toBeVisible();
	await expect(editor.getByText('pending.mp4', { exact: true })).toBeVisible();
	await expect(editor.getByRole('status').filter({ hasText: 'Previous draft restored' })).toBeVisible();
	await page.reload();
	await expect(editor.getByLabel('Channel logo crop preview')).toBeVisible();
	await expect(editor.getByText('pending.mp4', { exact: true })).toBeVisible();
	await reset(editor);
	await expect(editor.getByRole('button', { name: 'Close', exact: true })).toBeEnabled();
	await expect(editor.getByText('pending.mp4', { exact: true })).toHaveCount(0);
});

test('creates a Library and keeps its settings editor open after subsequent saves', async ({ page, documentationServer }) => {
	const { mediaRoot } = await seedSchedule(page, documentationServer.directory);
	await page.goto('/libraries/new');
	const editor = page.getByRole('dialog').last();
	const name = editor.getByRole('textbox', { name: 'Name', exact: true });
	await expect(editor.getByRole('button', { name: 'Add and Scan', exact: true })).toBeDisabled();
	await name.fill('New retained library');
	await editor.getByRole('textbox', { name: 'Path Moirai scans', exact: true }).fill(mediaRoot);
	await page.reload();
	await expect(name).toHaveValue('New retained library');
	await expect(editor.getByRole('status').filter({ hasText: 'Previous draft restored' })).toBeVisible();
	await editor.getByRole('button', { name: 'Add and Scan', exact: true }).click();
	await expect(page).toHaveURL(/\/libraries\/[^/]+\/settings$/);
	await expect(editor.getByRole('button', { name: 'Close', exact: true })).toBeEnabled();
	await name.fill('Updated retained library');
	await editor.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(editor.getByRole('button', { name: 'Close', exact: true })).toBeEnabled();
	await expect(page).toHaveURL(/\/settings$/);
	await name.fill('Pending reset');
	await reset(editor);
	await expect(name).toHaveValue('Updated retained library');
});

test('keeps embedded Program and Template editors open after saving', async ({ page, documentationServer }) => {
	const { channel } = await seedSchedule(page, documentationServer.directory);
	await page.goto(`/schedules/channels/${channel.id}`);
	await page.getByRole('dialog').last().locator('.base-inspector').getByRole('button', { name: /^Edit /u }).click();
	const templateEditor = page.getByRole('dialog', { name: 'Template editor', exact: true });
	await templateEditor.getByRole('textbox', { name: 'Template name', exact: true }).fill('Embedded template');
	await templateEditor.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(templateEditor.getByRole('button', { name: 'Close', exact: true })).toBeEnabled();
	await expect(page).toHaveURL(`/schedules/channels/${channel.id}`);
	await templateEditor.locator('.template-edit-program-button:enabled').click();
	const programEditor = page.getByRole('dialog', { name: 'Edit Program', exact: true });
	await programEditor.getByRole('textbox', { name: /^Name/u }).fill('Embedded program');
	await programEditor.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(programEditor.getByRole('button', { name: 'Close', exact: true })).toBeEnabled();
	await programEditor.getByRole('button', { name: 'Close', exact: true }).click();
	await expect(programEditor).toHaveCount(0);
	await expect(templateEditor).toBeVisible();
	await templateEditor.getByRole('button', { name: 'Close', exact: true }).click();
	await expect(templateEditor).toHaveCount(0);
	await expect(page.getByRole('dialog')).toHaveCount(1);
});
