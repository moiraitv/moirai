import { expect } from '@playwright/test';
import { test } from './fixture';
import { seedSchedule } from './seed';
import { captureSection } from './capture';

test('creates guided Mid-Rolls and saves reusable assignments', async ({ page, documentationServer }) => {
	const { channel, program, template, requestHeaders } = await seedSchedule(page, documentationServer.directory);
	await page.goto('/schedules/mid-roll-presets');
	await expect(page.getByRole('heading', { name: 'Mid-Rolls', exact: true })).toBeVisible();
	const builtin = page.locator('article').filter({ has: page.getByRole('heading', { name: 'Two-minute breaks', exact: true }) });
	await builtin.getByRole('button', { name: 'View', exact: true }).click();
	const presetEditor = page.getByRole('dialog');
	await expect(presetEditor.getByRole('spinbutton', { name: 'Seconds per Break' })).toBeDisabled();
	await expect(presetEditor.getByRole('button', { name: 'Delete Mid-Roll' })).toHaveCount(0);
	await presetEditor.getByRole('button', { name: 'Duplicate', exact: true }).click();
	await presetEditor.getByRole('textbox', { name: 'Name', exact: true }).fill('Shared intermissions');
	await presetEditor.getByRole('combobox', { name: 'Budget per Break' }).selectOption('count');
	await presetEditor.getByRole('spinbutton', { name: 'Items per Break' }).fill('2');
	const root = presetEditor.locator('.mid-roll-predicate > .predicate-node');
	await root.locator(':scope > .predicate-node-heading select').selectOption('any');
	await root.getByRole('button', { name: 'Group', exact: true }).click();
	const nested = root.locator(':scope > .predicate-children > .predicate-node').last();
	await nested.getByRole('button', { name: 'Condition', exact: true }).click();
	const leaf = nested.locator(':scope > .predicate-children > .predicate-node').last();
	await leaf.getByRole('combobox', { name: 'Predicate type' }).selectOption('every-nth');
	await leaf.getByRole('spinbutton', { name: 'Point interval' }).fill('0');
	await expect(presetEditor.getByRole('alert')).toBeVisible();
	await expect(presetEditor.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
	await leaf.getByRole('spinbutton', { name: 'Point interval' }).fill('2');
	await leaf.getByRole('checkbox', { name: 'Exclude', exact: true }).check();
	await expect(presetEditor.getByRole('textbox', { name: 'Break condition' })).toHaveCount(0);
	const created = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/api/v1/filler-presets'));
	await presetEditor.getByRole('button', { name: 'Save', exact: true }).click();
	const createResponse = await created;
	expect(createResponse.ok()).toBe(true);
	const preset = await createResponse.json();
	expect(preset.predicate).toMatchObject({ type: 'any', children: [{ type: 'number' }, { type: 'all', children: [{ type: 'number' }, { type: 'every-nth', interval: 2, negated: true }] }] });

	await page.goto(`/schedules/templates/${template.id}`);
	const editor = page.getByRole('dialog', { name: 'Template editor', exact: true });
	const defaults = editor.getByRole('group', { name: 'Template default mid-roll', exact: true });
	await expect(defaults.getByRole('checkbox')).not.toBeChecked();
	await expect(defaults.getByRole('combobox', { name: 'Preset', exact: true })).toBeDisabled();
	await expect(defaults.getByRole('combobox', { name: 'Source Program', exact: true })).toBeDisabled();
	await expect(defaults.getByRole('heading', { name: 'Template default mid-roll', exact: true })).toBeVisible();
	const combined = editor.getByRole('group', { name: 'Template default filler', exact: true });
	await expect(combined.getByRole('radio', { name: 'Mid-Roll Inactive', exact: true })).toBeChecked();
	await expect(combined.locator('.filler-example-gap.is-active')).toHaveCount(0);
	await expect(editor.getByRole('group', { name: 'Template default pre-roll', exact: true })).toHaveCount(0);
	await combined.getByRole('radio', { name: 'Pre-Roll Inactive', exact: true }).check();
	await expect(defaults).toHaveCount(0);
	await expect(combined.getByRole('group', { name: 'Template default pre-roll', exact: true })).toBeVisible();
	await combined.getByRole('radio', { name: 'Mid-Roll Inactive', exact: true }).check();
	await defaults.getByRole('checkbox').check();
	await defaults.getByRole('combobox', { name: 'Source Program', exact: true }).selectOption(program.id);
	await defaults.getByRole('combobox', { name: 'Preset', exact: true }).selectOption(preset.id);
	await expect(defaults.getByRole('combobox', { name: 'Preset', exact: true })).toHaveValue(preset.id);
	await expect(combined.locator('.filler-example-gap.is-active')).toHaveCount(13);
	await expect(combined.getByRole('radio', { name: 'Mid-Roll Active', exact: true })).toBeChecked();
	await defaults.getByRole('checkbox').uncheck();
	await expect(defaults.getByRole('combobox', { name: 'Preset', exact: true })).toBeDisabled();
	await expect(defaults.getByRole('combobox', { name: 'Source Program', exact: true })).toBeDisabled();
	await expect(defaults.getByRole('button', { name: 'Clear Mid-Roll', exact: true })).toHaveCount(0);
	await defaults.getByRole('checkbox').check();
	await defaults.getByRole('combobox', { name: 'Source Program', exact: true }).selectOption(program.id);
	await defaults.getByRole('combobox', { name: 'Preset', exact: true }).selectOption(preset.id);
	await editor.locator('.template-timeline').press('Enter');
	await editor.getByRole('button', { name: 'Advanced scheduling behavior' }).click();
	await editor.getByRole('group', { name: 'Slot mid-roll', exact: true }).getByRole('combobox', { name: 'Mode', exact: true }).selectOption('configured');
	const slotSettings = editor.getByRole('group', { name: 'Slot mid-roll settings', exact: true });
	await expect(slotSettings.getByRole('checkbox')).toBeChecked();
	await slotSettings.getByRole('checkbox').click();
	await expect(slotSettings).toBeHidden();
	await expect(editor.getByRole('group', { name: 'Slot mid-roll', exact: true }).getByRole('combobox', { name: 'Mode', exact: true })).toHaveValue('inherit');
	await editor.getByRole('group', { name: 'Slot mid-roll', exact: true }).getByRole('combobox', { name: 'Mode', exact: true }).selectOption('disabled');
	const saved = page.waitForResponse(response => response.request().method() === 'PATCH' && response.url().endsWith(`/api/v1/schedule-templates/${template.id}`));
	await editor.getByRole('button', { name: 'Save', exact: true }).click();
	expect((await saved).ok()).toBe(true);
	const persisted = await (await page.request.get(`/api/v1/schedule-templates/${template.id}`, { headers: requestHeaders })).json();
	expect(persisted.defaultMidRoll).toEqual({ programId: program.id, presetId: preset.id });
	expect(persisted.slots.some((slot: { midRoll?: { mode: string } }) => slot.midRoll?.mode === 'disabled')).toBe(true);
	await page.goto(`/schedules/templates/${template.id}`);
	await expect(defaults.getByRole('combobox', { name: 'Preset', exact: true })).toHaveValue(preset.id);

	expect((await page.request.put(`/api/v1/channels/${channel.id}/schedule`, {
		headers: requestHeaders, data: { defaultTemplateId: template.id },
	})).ok()).toBe(true);
	await page.goto(`/schedules/channels/${channel.id}`);
	const channelDefaults = page.getByRole('group', { name: 'Channel default mid-roll', exact: true });
	await channelDefaults.getByRole('checkbox').check();
	await channelDefaults.getByRole('combobox', { name: 'Source Program', exact: true }).selectOption(program.id);
	await channelDefaults.getByRole('combobox', { name: 'Preset', exact: true }).selectOption(preset.id);
	const channelSaved = page.waitForResponse(response => response.request().method() === 'PUT' && response.url().endsWith(`/api/v1/channels/${channel.id}/schedule`));
	await page.getByRole('button', { name: 'Save', exact: true }).click();
	expect((await channelSaved).ok()).toBe(true);
	await page.goto(`/schedules/channels/${channel.id}`);
	await expect(channelDefaults.getByRole('combobox', { name: 'Preset', exact: true })).toHaveValue(preset.id);

	await page.goto('/schedules/mid-roll-presets');
	await page.locator('article').filter({ has: page.getByRole('heading', { name: preset.name }) }).getByRole('button', { name: 'Edit', exact: true }).click();
	await presetEditor.getByRole('textbox', { name: 'Name', exact: true }).fill('Discard this rename');
	await presetEditor.getByRole('button', { name: 'Reset', exact: true }).click();
	await presetEditor.getByRole('button', { name: 'Confirm Reset', exact: true }).click();
	await expect(presetEditor.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue(preset.name);
	await presetEditor.getByRole('button', { name: 'Delete Mid-Roll' }).click();
	await page.getByRole('alertdialog').getByRole('button', { name: 'Delete Mid-Roll', exact: true }).click();
	await expect(presetEditor.getByText('Filler preset is in use; choose another Filler preset before deleting it')).toBeVisible();
});

test('captures the guided Mid-Roll editor', { tag: '@docs-screenshot' }, async ({ page, documentationServer }) => {
	await seedSchedule(page, documentationServer.directory);
	await page.goto('/schedules/mid-roll-presets');
	await page.locator('article').filter({ has: page.getByRole('heading', { name: 'Two-minute breaks', exact: true }) }).getByRole('button', { name: 'Duplicate', exact: true }).click();
	const editor = page.getByRole('dialog');
	await editor.getByRole('textbox', { name: 'Name', exact: true }).fill('Evening intermissions');
	await captureSection(page, editor.locator('.mid-roll-predicate'), 'mid-roll-predicate.png');
});

test('keeps the guided preset editor usable at a narrow viewport', async ({ page, documentationServer }) => {
	await seedSchedule(page, documentationServer.directory);
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto('/schedules/mid-roll-presets');
	await page.locator('article').filter({ has: page.getByRole('heading', { name: 'Two-minute breaks', exact: true }) }).getByRole('button', { name: 'Duplicate', exact: true }).click();
	const editor = page.getByRole('dialog');
	await expect(editor.getByRole('textbox', { name: 'Name', exact: true })).toBeVisible();
	await expect.poll(() => editor.locator('.resource-editor-scroll').evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
	const lastValue = editor.locator('.mid-roll-predicate').getByRole('spinbutton', { name: 'Value', exact: true }).last();
	await lastValue.fill('180');
	await expect(lastValue).toHaveValue('180');
	await expect(editor.getByRole('button', { name: 'Save', exact: true })).toBeInViewport();
	await page.keyboard.press('Escape');
	const confirmation = page.getByRole('alertdialog');
	await expect(confirmation).toBeVisible();
	await confirmation.getByRole('button', { name: 'Discard Changes', exact: true }).click();
	await expect(editor).toBeHidden();
});

test('configures all filler types and captures clock and random budgets', { tag: '@docs-screenshot' }, async ({ page, documentationServer }) => {
	const { template, program, requestHeaders } = await seedSchedule(page, documentationServer.directory);
	const nav = page.getByRole('navigation', { name: 'Primary navigation' });
	for (const [kind, route, label] of [['pre-roll', 'pre-rolls', 'Pre-Roll'], ['post-roll', 'post-rolls', 'Post-Roll'], ['tail', 'tail-fillers', 'Tail Filler']] as const) {
		await page.goto(`/filler/${route}`);
		await expect(nav.getByRole('link', { name: `${label}s`, exact: true })).toBeVisible();
		await page.getByRole('button', { name: `New ${label}`, exact: true }).click();
		const editor = page.getByRole('dialog');
		await editor.getByRole('textbox', { name: 'Name', exact: true }).fill(`${label} example`);
		const mode = editor.getByRole('combobox', { name: 'Budget per Break' });
		await mode.selectOption('random-count');
		await editor.getByRole('spinbutton', { name: 'Minimum Items' }).fill('0');
		await editor.getByRole('spinbutton', { name: 'Maximum Items' }).fill('3');
		if (kind === 'pre-roll') {
			await captureSection(page, editor.locator('.mid-roll-settings'), 'filler-random-budget.png');
		}
		await mode.selectOption('pad');
		await editor.getByRole('combobox', { name: 'Clock Interval (minutes)' }).selectOption('15');
		const fitting = editor.getByRole('combobox', { name: 'Fitting Behavior' });
		await expect(fitting.locator('option')).toHaveText(['Allow Truncation', 'Whole Items Only']);
		await fitting.selectOption('next-fit-only');
		if (kind === 'post-roll') {
			await captureSection(page, editor.locator('.mid-roll-settings'), 'filler-clock-budget.png');
		}
		if (kind === 'tail') {
			await mode.selectOption('remaining');
		}
		const saved = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/api/v1/filler-presets'));
		await editor.getByRole('button', { name: 'Save', exact: true }).click();
		const response = await saved;
		expect(response.ok()).toBe(true);
		const preset = await response.json();
		expect(preset.kind).toBe(kind);
		await page.goto(`/schedules/templates/${template.id}`);
		const templateEditor = page.getByRole('dialog', { name: 'Template editor', exact: true });
		await templateEditor.getByRole('group', { name: 'Template default filler', exact: true }).getByRole('radio', { name: new RegExp(`^${label} `) }).check();
		const panel = templateEditor.getByRole('group', { name: `Template default ${kind === 'tail' ? 'tail filler' : kind}`, exact: true });
		await panel.getByRole('checkbox').check();
		await panel.getByRole('combobox', { name: 'Preset', exact: true }).selectOption(preset.id);
		await panel.getByRole('combobox', { name: 'Source Program', exact: true }).selectOption(program.id);
		const updated = page.waitForResponse(result => result.request().method() === 'PATCH' && result.url().endsWith(`/api/v1/schedule-templates/${template.id}`));
		await templateEditor.getByRole('button', { name: 'Save', exact: true }).click();
		expect((await updated).ok()).toBe(true);
		const persisted = await (await page.request.get(`/api/v1/schedule-templates/${template.id}`, { headers: requestHeaders })).json();
		const field = kind === 'tail' ? 'defaultFiller' : kind === 'pre-roll' ? 'defaultPreRoll' : 'defaultPostRoll';
		expect(persisted[field]).toMatchObject({ presetId: preset.id, programId: program.id });
	}
	await page.goto('/filler/pre-rolls');
	await nav.getByRole('link', { name: 'Post-Rolls', exact: true }).click();
	await expect(page.getByRole('heading', { name: 'Post-Rolls', exact: true })).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Post-Roll example', exact: true })).toBeVisible();
});

test('switches combined filler types by keyboard and keeps a narrow assignment interface contained', async ({ page, documentationServer }) => {
	const { template } = await seedSchedule(page, documentationServer.directory);
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto(`/schedules/templates/${template.id}`);
	const editor = page.getByRole('dialog', { name: 'Template editor', exact: true });
	const combined = editor.getByRole('group', { name: 'Template default filler', exact: true });
	const mid = combined.getByRole('radio', { name: 'Mid-Roll Inactive', exact: true });
	await mid.focus();
	await mid.press('ArrowRight');
	await expect(combined.getByRole('radio', { name: 'Post-Roll Inactive', exact: true })).toBeChecked();
	await expect(combined.getByRole('group', { name: 'Template default post-roll', exact: true })).toBeVisible();
	await expect(combined.getByRole('group', { name: 'Template default mid-roll', exact: true })).toHaveCount(0);
	await combined.getByRole('button', { name: /^Mid-Roll · Inactive/ }).click();
	await combined.getByRole('checkbox').check();
	await expect(combined.locator('.filler-example-gap.is-active')).toHaveCount(13);
	await expect(combined.locator('.filler-example-gap.is-selected')).toHaveCount(13);
	const dimensions = await combined.evaluate(element => ({ overflow: element.scrollWidth - element.clientWidth, right: element.getBoundingClientRect().right }));
	expect(dimensions).toMatchObject({ overflow: 0 });
	expect(dimensions.right).toBeLessThanOrEqual(390);
});

test('excludes Sequence Programs from filler defaults, slot overrides, and fallback', async ({ page, documentationServer }) => {
	const { channel, program, template, requestHeaders } = await seedSchedule(page, documentationServer.directory);
	const response = await page.request.post('/api/v1/programs', { headers: requestHeaders, data: { name: 'A Sequence',
		config: { type: 'sequence', repeat: true, entries: [{ id: crypto.randomUUID(), programId: program.id, count: 1 }] } } });
	expect(response.ok()).toBe(true);
	const sequence = await response.json();
	await page.goto(`/schedules/templates/${template.id}`);
	const editor = page.getByRole('dialog', { name: 'Template editor', exact: true });
	const defaults = editor.getByRole('group', { name: 'Template default filler', exact: true });
	const labels = ['Pre-Roll', 'Mid-Roll', 'Post-Roll', 'Tail Filler'];
	for (const label of labels) {
		await defaults.getByRole('radio', { name: new RegExp(`^${label} `) }).check();
		await defaults.getByRole('checkbox').check();
		const source = defaults.getByRole('combobox', { name: 'Source Program', exact: true });
		await expect(source.locator(`option[value="${sequence.id}"]`)).toHaveCount(0);
		await expect(source).toHaveValue((await source.locator('option').first().getAttribute('value'))!);
		await defaults.getByRole('checkbox').uncheck();
	}
	await editor.locator('.template-timeline').press('Enter');
	await editor.getByRole('button', { name: 'Advanced scheduling behavior' }).click();
	const slot = editor.getByRole('group', { name: 'Slot filler', exact: true });
	for (const label of labels) {
		await slot.getByRole('radio', { name: new RegExp(`^${label} `) }).check();
		await slot.getByRole('combobox', { name: 'Mode', exact: true }).selectOption('configured');
		const source = slot.getByRole('combobox', { name: 'Source Program', exact: true });
		await expect(source.locator(`option[value="${sequence.id}"]`)).toHaveCount(0);
		await expect(source).toHaveValue((await source.locator('option').first().getAttribute('value'))!);
		await slot.getByRole('combobox', { name: 'Mode', exact: true }).selectOption('inherit');
	}
	expect((await page.request.put(`/api/v1/channels/${channel.id}/schedule`, { headers: requestHeaders, data: { defaultTemplateId: template.id } })).ok()).toBe(true);
	await page.goto(`/schedules/channels/${channel.id}`);
	const channelDefaults = page.getByRole('group', { name: 'Channel default filler', exact: true });
	for (const label of labels) {
		await channelDefaults.getByRole('radio', { name: new RegExp(`^${label} `) }).check();
		await channelDefaults.getByRole('checkbox').check();
		await expect(channelDefaults.getByRole('combobox', { name: 'Source Program', exact: true }).locator(`option[value="${sequence.id}"]`)).toHaveCount(0);
		await channelDefaults.getByRole('checkbox').uncheck();
	}
	const fallback = page.locator('#channel-default-filler');
	await fallback.getByRole('checkbox').check();
	await expect(fallback.getByRole('combobox', { name: 'Program', exact: true }).locator(`option[value="${sequence.id}"]`)).toHaveCount(0);
	await page.route('**/api/v1/scheduling/overview', async route => {
		const response = await route.fetch();
		await route.fulfill({ json: { ...await response.json(), programs: [sequence] } });
	});
	await page.goto(`/schedules/templates/${template.id}`);
	await expect(defaults.getByRole('checkbox')).toBeDisabled();
	await expect(defaults.getByRole('combobox', { name: 'Source Program', exact: true }).locator('option')).toHaveCount(0);
});
