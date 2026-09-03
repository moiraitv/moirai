import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { SECONDS_PER_SCHEDULING_DAY, type TimelinePreview } from '@moirai/shared';
import { authenticateAdministrator } from './authentication';

test('opens cause-specific editors without losing the channel draft', async ({ page }) => {
	const csrfToken = await authenticateAdministrator(page);
	const headers = { 'x-moirai-csrf': csrfToken };
	const runId = randomUUID();
	const channelResponse = await page.request.post('/api/v1/channels', {
		headers, data: { number: '98.7', name: `Diagnostics ${runId}` },
	});
	expect(channelResponse.ok()).toBe(true);
	const channel = await channelResponse.json() as { id: string };
	const programResponse = await page.request.post('/api/v1/programs', {
		headers,
		data: {
			name: `Diagnostic filler ${runId}`,
			config: { type: 'content', source: { type: 'item', itemId: randomUUID() }, strategy: { type: 'sequential' } },
		},
	});
	expect(programResponse.ok()).toBe(true);
	const program = await programResponse.json() as { id: string };
	const slotId = randomUUID();
	const templateName = `Diagnostic template ${runId}`;
	const templateResponse = await page.request.post('/api/v1/schedule-templates', {
		headers,
		data: {
			name: templateName,
			defaultFiller: { programId: program.id, policy: 'best-fit-only' },
			slots: [{ id: slotId, startSeconds: 0, programId: program.id }],
			boundaries: [{
				id: randomUUID(), leftSlotId: slotId, rightSlotId: slotId,
				targetSeconds: SECONDS_PER_SCHEDULING_DAY, policy: 'hard',
			}],
		},
	});
	expect(templateResponse.ok()).toBe(true);
	const template = await templateResponse.json() as { id: string };
	const layerId = randomUUID();
	const scheduleResponse = await page.request.put(`/api/v1/channels/${channel.id}/schedule`, {
		headers,
		data: {
			defaultTemplateId: template.id,
			layers: [{
				id: layerId, templateId: template.id,
				predicate: { type: 'time-range', startSeconds: 3600, endSeconds: 10800 },
			}],
		},
	});
	expect(scheduleResponse.ok()).toBe(true);

	// Isolate two precise causes while exercising the real editors and saved configuration.
	await page.route('**/api/v1/channel-schedule-preview', async (route) => {
		const response = await route.fetch();
		const body = await response.json() as TimelinePreview;
		const base = body.segments[0]!;
		const start = Date.parse(base.start);
		const at = (seconds: number): string => new Date(start + seconds * 1000).toISOString();
		const entryGap = {
			...base, id: 'entry-gap', scheduleLayerId: null,
			start: at(3600 - 12), finish: at(3600), role: 'dead-air' as const,
		};
		const fillerGap = {
			...base, id: 'filler-gap', scheduleLayerId: layerId,
			start: at(7200), finish: at(7200 + 480), role: 'dead-air' as const,
		};
		body.segments = [entryGap, fillerGap];
		body.issues = [
			{
				code: 'boundary-start-rejected', message: 'Entry boundary could not resolve.',
				templateId: template.id, slotId, scheduleLayerId: layerId,
				programId: program.id, mediaItemId: null, occurrenceCount: 1,
				occurrences: [{ start: entryGap.start, finish: entryGap.finish, boundaryOrigin: 'layer-entry' }],
			},
			{
				code: 'source-unavailable', message: 'Filler source is unavailable.',
				templateId: template.id, slotId, scheduleLayerId: layerId,
				programId: program.id, mediaItemId: null, occurrenceCount: 1,
				occurrences: [{ start: fillerGap.start, finish: fillerGap.finish, boundaryOrigin: 'layer-exit' }],
			},
		];
		await route.fulfill({ response, json: body });
	});
	await page.goto(`/schedules/channels/${channel.id}?layer=${layerId}&previewDate=2026-09-02&boundary=layer-exit`);
	await expect(page.getByRole('group', { name: 'Exit boundary' }).getByLabel('Boundary behavior')).toBeFocused();
	await expect(page.locator('.dead-air-diagnostics')).toContainText('2 gaps · 8m 12s total');
	const entryBoundary = page.getByRole('group', { name: 'Entry boundary' });
	await entryBoundary.getByLabel('Boundary behavior').selectOption('finish-left');
	await entryBoundary.getByLabel('Maximum drift past boundary (minutes)').fill('42');
	await expect(page.locator('.channel-schedule-save-state')).toContainText('Unsaved changes');

	const reviewFiller = page.locator('#dead-air-diagnostic-filler-gap').getByRole('button', { name: 'Review filler', exact: true });
	await reviewFiller.focus();
	await page.keyboard.press('Enter');
	const templateEditor = page.getByRole('dialog', { name: 'Template editor' });
	await expect(templateEditor).toBeVisible();
	await expect(templateEditor.getByLabel('Template name')).toHaveValue(templateName);
	await templateEditor.getByRole('button', { name: /Close/ }).click();
	await expect(templateEditor).toBeHidden();
	await expect(entryBoundary.getByLabel('Maximum drift past boundary (minutes)')).toHaveValue('42');
	await expect(page.locator('.channel-schedule-save-state')).toContainText('Unsaved changes');

	await page.setViewportSize({ width: 390, height: 844 });
	await page.locator('#dead-air-diagnostic-entry-gap').getByRole('button', { name: 'Review entry boundary' }).click();
	await expect(entryBoundary.getByLabel('Boundary behavior')).toBeFocused();
	await expect(page).toHaveURL(new RegExp(`layer=${layerId}.*boundary=layer-entry`));
	await expect(entryBoundary.getByLabel('Maximum drift past boundary (minutes)')).toHaveValue('42');
	await expect(page.locator('.channel-schedule-save-state')).toContainText('Unsaved changes');
});
