import { randomUUID } from 'node:crypto';
import { expect } from '@playwright/test';
import { test } from './fixture';
import { seedSchedule } from './seed';

test('saves all sequence ordering modes and resets ordering drafts', async ({ page, documentationServer }) => {
	const { sequenceProgramIds, requestHeaders, template, channel } = await seedSchedule(page, documentationServer.directory);
	const response = await page.request.post('/api/v1/programs', { headers: requestHeaders, data: {
		name: 'Ordering fixture', config: { type: 'sequence', repeat: true, entries: sequenceProgramIds.map((programId, index) => ({ id: randomUUID(), programId, count: 3 - index })) },
	} });
	expect(response.ok()).toBe(true);
	const { id } = await response.json() as { id: string };
	for (const [type, label] of [['ordered', 'Ordered'], ['shuffled-blocks', 'Shuffled blocks'], ['shuffled-allocations', 'Shuffled allocations'], ['balanced-rotation', 'Balanced rotation'], ['chance', 'Chance']] as const) {
		await page.goto(`/schedules/programs/${id}`);
		await page.getByRole('button', { name: new RegExp(`^${label} `) }).click();
		const seed = page.getByRole('textbox', { name: 'Stable seed' });
		if (type.startsWith('shuffled') || type === 'chance') {
			await seed.fill('browser-seed');
		}
		else {
			await expect(seed).toHaveCount(0);
		}
		if (type === 'chance') {
			await page.getByRole('spinbutton', { name: 'Step 2 chance (%)', exact: true }).fill('30');
			await page.getByRole('spinbutton', { name: 'Step 3 chance (%)', exact: true }).fill('0');
			await page.getByRole('button', { name: /^Balanced rotation / }).click();
			await expect(page.getByRole('spinbutton', { name: 'Step 2 count', exact: true })).toHaveValue('2');
			await expect(page.getByRole('button', { name: 'Reset', exact: true })).toBeDisabled();
			await page.getByRole('button', { name: /^Chance / }).click();
			await expect(page.getByRole('spinbutton', { name: 'Step 2 chance (%)', exact: true })).toHaveValue('30');
		}
		await page.getByPlaceholder('e.g. Evening Lineup').fill(`Ordering fixture ${type}`);
		await page.getByRole('button', { name: 'Save', exact: true }).click();
		await page.getByRole('button', { name: 'Close', exact: true }).click();
		await expect(page).toHaveURL(/\/schedules\/programs(?:\?.*)?$/);
		await page.goto(`/schedules/programs/${id}`);
		await expect(page.getByRole('button', { name: new RegExp(`^${label} `) })).toHaveAttribute('aria-pressed', 'true');
		if (type.startsWith('shuffled') || type === 'chance') {
			await expect(seed).toHaveValue('browser-seed');
		}
		const saved = await (await page.request.get(`/api/v1/programs/${id}`)).json();
		expect(saved.config.ordering.type).toBe(type);
		if (type === 'chance') {
			expect(saved.config.entries.map((entry: { count: number }) => entry.count)).toEqual([100, 30, 0]);
			await expect(page.locator('.sequence-guide-segment').first()).toBeAttached();
		}
	}
	await page.getByRole('button', { name: /^Shuffled blocks / }).click();
	await page.getByRole('button', { name: 'Reset', exact: true }).click();
	await page.getByRole('button', { name: 'Confirm Reset', exact: true }).click();
	await expect(page.getByRole('button', { name: /^Chance / })).toHaveAttribute('aria-pressed', 'true');
	await expect(page.getByRole('button', { name: 'Close', exact: true })).toBeEnabled();
	await expect(page.getByRole('button', { name: 'Reset', exact: true })).toBeDisabled();
	await page.setViewportSize({ width: 390, height: 844 });
	await page.getByRole('button', { name: /^Shuffled allocations / }).scrollIntoViewIfNeeded();
	await expect(page.getByRole('button', { name: /^Shuffled allocations / })).toBeVisible();
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto(`/schedules/templates/${template.id}`);
	const editor = page.getByRole('dialog', { name: 'Template editor', exact: true });
	await editor.getByRole('group', { name: 'Template default filler', exact: true }).getByRole('radio', { name: /^Pre-Roll / }).check();
	const preRoll = editor.getByRole('group', { name: 'Template default pre-roll', exact: true });
	await preRoll.getByRole('checkbox').check();
	await preRoll.getByRole('combobox', { name: 'Source Program', exact: true }).selectOption(id);
	const updated = page.waitForResponse(result => result.request().method() === 'PATCH' && result.url().endsWith(`/api/v1/schedule-templates/${template.id}`));
	await editor.getByRole('button', { name: 'Save', exact: true }).click();
	expect((await updated).ok()).toBe(true);
	const persisted = await (await page.request.get(`/api/v1/schedule-templates/${template.id}`)).json();
	expect(persisted.defaultPreRoll.programId).toBe(id);

	const assigned = await page.request.put(`/api/v1/channels/${channel.id}/schedule`, {
		headers: requestHeaders,
		data: { defaultTemplateId: template.id, defaultFiller: { programId: id, policy: 'next-truncate' } },
	});
	expect(assigned.ok(), await assigned.text()).toBe(true);
	await page.goto(`/schedules/channels/${channel.id}`);
	await expect(page.locator('.scheduling-preview-dock .preview-filler-tick.stage-pre-roll').first()).toBeVisible();
});
