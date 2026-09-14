import { expect, test } from '@playwright/test';
import { authenticateAdministrator } from './authentication';

test('closes created and edited templates and channel schedules, retaining failed drafts', async ({ page }) => {
	const headers = { 'x-moirai-csrf': await authenticateAdministrator(page) };
	await page.goto('/schedules/templates/new');
	const templateEditor = page.getByRole('dialog', { name: 'Template editor', exact: true });
	await templateEditor.getByLabel('Template name').fill('Close after save');
	await page.route('**/api/v1/schedule-templates', async (route) => {
		if (route.request().method() === 'POST') {
			await route.fulfill({ status: 503, json: { message: 'Test save unavailable' } });
		}
		else {
			await route.continue();
		}
	});
	await templateEditor.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(templateEditor.getByText('Test save unavailable')).toBeVisible();
	await expect(templateEditor.getByLabel('Template name')).toHaveValue('Close after save');
	await page.unroute('**/api/v1/schedule-templates');
	const created = page.waitForResponse(response => response.request().method() === 'POST'
		&& new URL(response.url()).pathname === '/api/v1/schedule-templates');
	await templateEditor.getByRole('button', { name: 'Save', exact: true }).click();
	const template = await (await created).json() as { id: string };
	await expect(templateEditor).toBeHidden();
	await expect(page).toHaveURL(/\/schedules\/templates$/);

	await page.goto(`/schedules/templates/${template.id}`);
	await templateEditor.getByLabel('Template name').fill('Edited and closed');
	await templateEditor.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(templateEditor).toBeHidden();
	await expect(page).toHaveURL(/\/schedules\/templates$/);
	await page.goto(`/schedules/templates/${template.id}`);
	await expect(templateEditor.getByLabel('Template name')).toHaveValue('Edited and closed');
	await templateEditor.getByLabel('Template name').fill('Saved through close');
	await templateEditor.getByRole('button', { name: 'Close template editor' }).click();
	await page.getByRole('alertdialog').getByRole('button', { name: 'Save Changes', exact: true }).click();
	await expect(templateEditor).toBeHidden();

	const response = await page.request.post('/api/v1/channels', { headers, data: { number: '985', name: 'Schedule close test' } });
	expect(response.ok()).toBe(true);
	const channel = await response.json() as { id: string };
	await page.goto(`/schedules/channels/${channel.id}`);
	const scheduleEditor = page.getByRole('dialog', { name: 'Channel schedule editor', exact: true });
	await scheduleEditor.getByLabel('Base template', { exact: true }).selectOption(template.id);
	await page.route(`**/api/v1/channels/${channel.id}/schedule`, async (route) => {
		await route.fulfill({ status: 503, json: { message: 'Test schedule unavailable' } });
	});
	await scheduleEditor.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(scheduleEditor.getByText('Test schedule unavailable')).toBeVisible();
	await expect(scheduleEditor.getByLabel('Base template', { exact: true })).toHaveValue(template.id);
	await page.unroute(`**/api/v1/channels/${channel.id}/schedule`);
	await scheduleEditor.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(scheduleEditor).toBeHidden();
	await expect(page).toHaveURL(/\/schedules\/channels$/);
	await page.request.delete(`/api/v1/channels/${channel.id}`, { headers });
	await page.request.delete(`/api/v1/schedule-templates/${template.id}`, { headers });
});
