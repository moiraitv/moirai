import { expect } from '@playwright/test';
import { captureSection } from './capture';
import { test } from './fixture';
import { seedSchedule } from './seed';

test('saves roll frequency at each assignment level', { tag: '@docs-screenshot' }, async ({ page, documentationServer }) => {
	const { channel, program, template, sequenceProgramIds, requestHeaders } = await seedSchedule(page, documentationServer.directory);
	const templateUrl = `/api/v1/schedule-templates/${template.id}`;
	const scheduleUrl = `/api/v1/channels/${channel.id}/schedule`;
	const assigned = await page.request.put(scheduleUrl, { headers: requestHeaders, data: { defaultTemplateId: template.id } });
	expect(assigned.ok(), await assigned.text()).toBe(true);
	const preset = await page.request.post('/api/v1/filler-presets', { headers: requestHeaders, data: {
		kind: 'post-roll', name: 'One-minute closing', budget: { type: 'duration', seconds: 60, policy: 'next-truncate' },
	} });
	expect(preset.ok(), await preset.text()).toBe(true);
	const closingId = (await preset.json()).id;

	await page.goto(`/schedules/templates/${template.id}`);
	const editor = page.getByRole('dialog', { name: 'Template editor' });
	const defaults = editor.getByRole('group', { name: 'Template default filler', exact: true });
	await defaults.getByRole('radio', { name: /^Post-Roll / }).check();
	const closing = defaults.getByRole('group', { name: 'Template default post-roll', exact: true });
	await closing.getByRole('checkbox').check();
	const frequency = closing.getByRole('combobox', { name: 'Frequency' });
	await expect(frequency).toHaveValue('per-item');
	await frequency.selectOption('once-per-slot');
	await closing.getByRole('combobox', { name: 'Preset' }).selectOption(closingId);
	await closing.getByRole('combobox', { name: 'Source Program' }).selectOption(sequenceProgramIds[1]!);
	await expect(frequency).toHaveValue('once-per-slot');
	await page.setViewportSize({ width: 1440, height: 1000 });
	await captureSection(page, defaults, 'template-slot-roll.png');

	await editor.getByRole('button', { name: 'Advanced scheduling behavior' }).click();
	const slotFiller = editor.getByRole('group', { name: 'Slot filler', exact: true });
	await slotFiller.getByRole('radio', { name: /^Pre-Roll / }).check();
	const opening = slotFiller.getByRole('group', { name: 'Slot pre-roll', exact: true });
	await opening.getByRole('combobox', { name: 'Mode' }).selectOption('configured');
	await opening.getByRole('combobox', { name: 'Frequency' }).selectOption('once-per-slot');
	await opening.getByRole('combobox', { name: 'Source Program' }).selectOption(program.id);
	const templateSaved = page.waitForResponse(response => response.request().method() === 'PATCH' && response.url().endsWith(templateUrl));
	await editor.getByRole('button', { name: 'Save', exact: true }).click();
	expect((await templateSaved).ok()).toBe(true);
	await expect(editor.getByRole('button', { name: 'Save', exact: true })).toBeHidden();

	await page.reload();
	await defaults.getByRole('radio', { name: /^Post-Roll / }).check();
	await expect(frequency).toHaveValue('once-per-slot');
	await expect(closing.getByRole('combobox', { name: 'Preset' })).toHaveValue(closingId);
	await expect(closing.getByRole('combobox', { name: 'Source Program' })).toHaveValue(sequenceProgramIds[1]!);
	if (!await slotFiller.isVisible()) {
		await editor.getByRole('button', { name: 'Advanced scheduling behavior' }).click();
	}
	await slotFiller.getByRole('radio', { name: /^Pre-Roll / }).check();
	await expect(opening.getByRole('combobox', { name: 'Frequency' })).toHaveValue('once-per-slot');

	await page.goto(`/schedules/channels/${channel.id}`);
	const channelEditor = page.getByRole('dialog', { name: 'Channel schedule editor' });
	const channelDefaults = channelEditor.getByRole('group', { name: 'Channel default filler', exact: true });
	await channelDefaults.getByRole('radio', { name: /^Pre-Roll / }).check();
	await channelDefaults.getByRole('checkbox').check();
	const channelFrequency = channelDefaults.getByRole('combobox', { name: 'Frequency' });
	await expect(channelFrequency).toHaveValue('per-item');
	await channelFrequency.selectOption('once-per-slot');
	const channelSaved = page.waitForResponse(response => response.request().method() === 'PUT' && response.url().endsWith(scheduleUrl));
	await channelEditor.getByRole('button', { name: 'Save', exact: true }).click();
	expect((await channelSaved).ok()).toBe(true);
	await expect(channelEditor.getByRole('button', { name: 'Save', exact: true })).toBeHidden();
	await page.reload();
	await channelDefaults.getByRole('radio', { name: /^Pre-Roll / }).check();
	await expect(channelFrequency).toHaveValue('once-per-slot');
});
