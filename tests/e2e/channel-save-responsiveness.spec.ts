import { expect, test } from '@playwright/test';
import { authenticateAdministrator } from './authentication';

for (const asset of ['fallback', 'logo'] as const) {
	test(`keeps creation chrome and the persisted ID through a delayed ${asset} failure and retry`, async ({ page }) => {
		const headers = { 'x-moirai-csrf': await authenticateAdministrator(page) };
		let channelId = '';
		let creates = 0;
		let updates = 0;
		let uploads = 0;
		let release!: () => void;
		const gate = new Promise<void>(resolve => {
			release = resolve;
		});
		await page.route('**/api/v1/channels', async route => {
			if (route.request().method() !== 'POST') {
				await route.continue();
				return;
			}
			creates += 1;
			const response = await route.fetch();
			channelId = (await response.json()).id;
			await gate;
			await route.fulfill({ response });
		});
		await page.route('**/api/v1/channels/*', async route => {
			if (route.request().method() === 'PATCH') {
				updates += 1;
			}
			await route.continue();
		});
		await page.route(`**/api/v1/channels/*/${asset === 'fallback' ? 'fallback-filler' : 'logo'}`, async route => {
			if (route.request().method() === 'PUT') {
				uploads += 1;
				await route.fulfill({ status: 422, json: { message: 'Fixture fallback rejected', code: 'validation_error' } });
				return;
			}
			await route.continue();
		});
		try {
			await page.goto('/channels?new=1');
			const editor = page.getByRole('dialog', { name: 'Create Channel', exact: true });
			await editor.getByRole('textbox', { name: 'Number', exact: true }).fill('988');
			await editor.getByRole('textbox', { name: 'Name', exact: true }).fill('Responsive creation');
			if (asset === 'fallback') {
				await editor.getByRole('button', { name: /Channel fallback override/ }).click();
				await editor.locator('.fallback-filler-editor input[type=file]').setInputFiles({ name: 'fallback.mp4', mimeType: 'video/mp4', buffer: Buffer.from('fixture') });
			}
			else {
				await editor.locator('input[accept="image/*"]').setInputFiles({ name: 'logo.png', mimeType: 'image/png',
					buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64') });
			}
			await editor.getByRole('button', { name: 'Save', exact: true }).click();
			await expect.poll(() => channelId).not.toBe('');
			await expect(editor).toBeVisible();
			await expect(editor.getByRole('button', { name: 'Saving channel…', exact: true })).toBeVisible();
			const frameDelays = await page.evaluate(async () => {
				const delays: number[] = [];
				let last = performance.now();
				for (let index = 0; index < 12; index += 1) {
					await new Promise(requestAnimationFrame);
					const now = performance.now();
					delays.push(now - last);
					last = now;
				}
				return delays;
			});
			expect(Math.max(...frameDelays)).toBeLessThan(500);
			release();
			await expect(editor.getByText(asset === 'fallback' ? /Channel changes were saved, but the fallback filler was not/ : /Channel changes were saved, but the logo was not/)).toBeVisible();
			await expect(editor).toBeVisible();
			await expect(page.getByRole('dialog', { name: 'Edit Channel', exact: true })).toBeHidden();
			await editor.getByRole('button', { name: 'Save', exact: true }).click();
			await expect.poll(() => uploads).toBe(2);
			expect(creates).toBe(1);
			expect(updates).toBe(1);
			if (asset === 'fallback') {
				await expect(editor.locator('.fallback-filler-editor')).toContainText('fallback.mp4');
			}
			else {
				await expect(editor.locator('.channel-logo-crop-stage')).toBeVisible();
			}
		}
		finally {
			release();
			await page.unrouteAll({ behavior: 'wait' });
			if (channelId) {
				await page.request.delete(`/api/v1/channels/${channelId}`, { headers });
			}
		}
	});
}

test('shows preparation during a cached guide refresh and retains a failed row until retry', async ({ page }) => {
	const headers = { 'x-moirai-csrf': await authenticateAdministrator(page) };
	const created = await page.request.post('/api/v1/channels', { headers, data: { number: '989', name: 'Preparing fixture' } });
	expect(created.ok()).toBe(true);
	const channel = await created.json();
	let templateId = '';
	let release!: () => void;
	const gate = new Promise<void>(resolve => {
		release = resolve;
	});
	try {
		await page.goto('/channels');
		await expect(page.getByText('No template assigned', { exact: true }).first()).toBeVisible();
		await page.route('**/api/v1/schedule-guide?*', async route => {
			await gate;
			await route.fulfill({ status: 503, json: { message: 'Fixture generation failed', code: 'service_unavailable' } });
		});
		const slotId = '00000000-0000-4000-8000-000000000011';
		const template = await page.request.post('/api/v1/schedule-templates', { headers, data: {
			name: 'Preparation fixture', slots: [{ id: slotId, startSeconds: 0, programId: null, filler: { mode: 'disabled' } }],
			boundaries: [{ id: '00000000-0000-4000-8000-000000000012', leftSlotId: slotId, rightSlotId: slotId, targetSeconds: 86400 }],
		} });
		expect(template.ok()).toBe(true);
		templateId = (await template.json()).id;
		const assigned = await page.request.put(`/api/v1/channels/${channel.id}/schedule`, { headers,
			data: { defaultTemplateId: templateId, layers: [], defaultFiller: null } });
		expect(assigned.ok()).toBe(true);
		await expect(page.getByText('Updating guide…', { exact: true })).toBeVisible();
		await expect(page.getByText('Preparing guide…', { exact: true })).toBeInViewport();
		await page.screenshot({ path: 'test-results/channel-guide-preparing.png' });
		release();
		await expect(page.getByText('Guide could not be loaded.', { exact: true })).toBeInViewport();
		await page.unroute('**/api/v1/schedule-guide?*');
		await page.getByRole('button', { name: 'Retry', exact: true }).click();
		await expect(page.getByText('Guide could not be loaded.', { exact: true })).toBeHidden();
		await expect(page.getByText('Updating guide…', { exact: true })).toBeHidden({ timeout: 60_000 });
	}
	finally {
		release();
		await page.unrouteAll({ behavior: 'wait' });
		await page.request.delete(`/api/v1/channels/${channel.id}`, { headers });
		if (templateId) {
			await page.request.delete(`/api/v1/schedule-templates/${templateId}`, { headers });
		}
	}
});
