import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { authenticateAdministrator } from './authentication';

test('switches base and conditional schedule pickers to programs and saves their assignments', async ({ page }) => {
	const headers = { 'x-moirai-csrf': await authenticateAdministrator(page) };
	const name = `Direct schedule ${Date.now()}`;
	const programResponse = await page.request.post('/api/v1/programs', { headers, data: {
		name, config: { type: 'content', source: { type: 'item', itemId: randomUUID() },
			strategy: { type: 'sequential' } },
	} });
	expect(programResponse.ok()).toBe(true);
	const program = await programResponse.json() as { id: string };
	const slotId = randomUUID();
	const templateResponse = await page.request.post('/api/v1/schedule-templates', { headers, data: {
		name: `${name} template`,
		slots: [{ id: slotId, startSeconds: 0, programId: program.id }],
		boundaries: [{ id: randomUUID(), leftSlotId: slotId, rightSlotId: slotId,
			targetSeconds: 86_400 }],
	} });
	expect(templateResponse.ok()).toBe(true);
	const template = await templateResponse.json() as { id: string };
	const channelResponse = await page.request.post('/api/v1/channels', { headers,
		data: { number: String(700 + Math.floor(Math.random() * 200)), name } });
	expect(channelResponse.ok()).toBe(true);
	const channel = await channelResponse.json() as { id: string };
	const templatesBefore = await (await page.request.get('/api/v1/schedule-templates')).json() as unknown[];

	await page.goto(`/schedules/channels/${channel.id}`);
	const editor = page.getByRole('dialog', { name: 'Channel schedule editor' });
	if (await editor.getByLabel('Base template', { exact: true }).count()) {
		await editor.getByRole('button', { name: 'Switch base to program' }).click();
	}
	await editor.getByLabel('Base program', { exact: true }).selectOption(program.id);
	await expect(editor.locator('.base-inspector .eyebrow').first()).toContainText('Base program');
	await expect(editor.getByRole('button', { name: 'Switch base to template' }).locator('svg')).toBeVisible();
	await editor.getByRole('button', { name: 'Switch base to template' }).click();
	await editor.getByRole('button', { name: 'Switch base to program' }).click();
	await expect(editor.getByLabel('Base program', { exact: true })).toHaveValue(program.id);
	await editor.getByRole('button', { name: 'Add conditional template' }).click();
	if (await editor.getByLabel('Conditional layer template', { exact: true }).count()) {
		await editor.getByRole('button', { name: 'Switch conditional layer to program' }).click();
	}
	await editor.getByLabel('Conditional layer program', { exact: true }).selectOption(program.id);
	await expect(editor.locator('.schedule-layer-inspector .eyebrow').first()).toContainText('Conditional program');
	await expect(editor.locator('.schedule-layer.conditional')).toContainText(name);
	await editor.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(editor).toBeHidden();

	const schedule = await (await page.request.get(`/api/v1/channels/${channel.id}/schedule`)).json() as {
		defaultProgramId: string; defaultTemplateId: string | null;
		layers: Array<{ programId: string; templateId: string | null }>;
	};
	expect(schedule).toMatchObject({ defaultProgramId: program.id, defaultTemplateId: null,
		layers: [{ programId: program.id, templateId: null }] });
	expect(await (await page.request.get('/api/v1/schedule-templates')).json()).toHaveLength(templatesBefore.length);
	await page.goto(`/schedules/channels/${channel.id}`);
	await editor.locator('.schedule-layer.base').click();
	await editor.getByRole('button', { name: 'Switch base to template' }).click();
	await expect(editor.getByLabel('Base template', { exact: true })).toHaveValue(template.id);
	await editor.getByRole('button', { name: 'Reset', exact: true }).click();
	await editor.getByRole('button', { name: 'Confirm Reset', exact: true }).click();
	await editor.locator('.schedule-layer.base').click();
	await expect(editor.getByLabel('Base program', { exact: true })).toHaveValue(program.id);
	await editor.locator('.schedule-layer.conditional').click();
	await expect(editor.getByLabel('Conditional layer program', { exact: true })).toHaveValue(program.id);
	await page.request.delete(`/api/v1/channels/${channel.id}`, { headers });
	await page.request.delete(`/api/v1/schedule-templates/${template.id}`, { headers });
	await page.request.delete(`/api/v1/programs/${program.id}`, { headers });
});

test('creates a channel schedule when no saved templates exist', async ({ page }) => {
	const headers = { 'x-moirai-csrf': await authenticateAdministrator(page) };
	const programResponse = await page.request.post('/api/v1/programs', { headers, data: {
		name: `Program only ${Date.now()}`,
		config: { type: 'content', source: { type: 'item', itemId: randomUUID() },
			strategy: { type: 'sequential' } },
	} });
	expect(programResponse.ok()).toBe(true);
	const program = await programResponse.json() as { id: string };
	const channelResponse = await page.request.post('/api/v1/channels', { headers, data: {
		number: String(700 + Math.floor(Math.random() * 200)), name: 'Program only channel',
	} });
	expect(channelResponse.ok()).toBe(true);
	const channel = await channelResponse.json() as { id: string };
	await page.goto(`/schedules/channels/${channel.id}`);
	const editor = page.getByRole('dialog', { name: 'Channel schedule editor' });
	await expect(editor.getByLabel('Base program', { exact: true })).toHaveValue(program.id);
	await editor.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(editor).toBeHidden();
	await page.request.delete(`/api/v1/channels/${channel.id}`, { headers });
	await page.request.delete(`/api/v1/programs/${program.id}`, { headers });
});

test('suggests a matching program ahead of unrelated templates for a new schedule', async ({ page }) => {
	const headers = { 'x-moirai-csrf': await authenticateAdministrator(page) };
	const name = `Program match ${randomUUID()}`;
	const programResponse = await page.request.post('/api/v1/programs', { headers, data: {
		name, config: { type: 'content', source: { type: 'item', itemId: randomUUID() },
			strategy: { type: 'sequential' } },
	} });
	expect(programResponse.ok()).toBe(true);
	const program = await programResponse.json() as { id: string };
	const slotId = randomUUID();
	const templateResponse = await page.request.post('/api/v1/schedule-templates', { headers, data: {
		name: `Unrelated template ${randomUUID()}`,
		slots: [{ id: slotId, startSeconds: 0, programId: program.id }],
		boundaries: [{ id: randomUUID(), leftSlotId: slotId, rightSlotId: slotId,
			targetSeconds: 86_400 }],
	} });
	expect(templateResponse.ok()).toBe(true);
	const template = await templateResponse.json() as { id: string };
	const channelResponse = await page.request.post('/api/v1/channels', { headers,
		data: { number: String(700 + Math.floor(Math.random() * 200)), name } });
	expect(channelResponse.ok()).toBe(true);
	const channel = await channelResponse.json() as { id: string };

	await page.goto(`/schedules/channels/${channel.id}`);
	await expect(page.getByRole('dialog', { name: 'Channel schedule editor' })
		.getByLabel('Base program', { exact: true })).toHaveValue(program.id);

	await page.request.delete(`/api/v1/channels/${channel.id}`, { headers });
	await page.request.delete(`/api/v1/schedule-templates/${template.id}`, { headers });
	await page.request.delete(`/api/v1/programs/${program.id}`, { headers });
});
