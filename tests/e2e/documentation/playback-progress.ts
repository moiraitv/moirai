import type { ScheduleTemplate } from '@moirai/shared';
import { expect } from '@playwright/test';
import { test } from './fixture';
import { captureThrough } from './capture';
import { seedSchedule } from './seed';

function playbackSlots(template: ScheduleTemplate) {
	return template.slots.map(({ guide, ...slot }) => {
		void guide;
		return slot;
	});
}

test('captures direct program progress and follows base and conditional assignment changes', { tag: '@docs-screenshot' }, async ({ page, documentationServer }) => {
	const { channel, program, template, requestHeaders } = await seedSchedule(page, documentationServer.directory);
	const assigned = await page.request.put(`/api/v1/channels/${channel.id}/schedule`, {
		headers: requestHeaders, data: { defaultProgramId: program.id },
	});
	expect(assigned.ok(), await assigned.text()).toBe(true);
	await page.goto(`/schedules/channels/${channel.id}`);
	const progress = page.locator('.schedule-playback-progress');
	await expect(progress).toBeVisible();
	await captureThrough(page, page.locator('.base-inspector'), progress, 'channel-schedule-direct-program.png');
	await page.setViewportSize({ width: 390, height: 844 });
	await progress.scrollIntoViewIfNeeded();
	await expect(progress).toBeVisible();
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
	await page.screenshot({ path: 'test-results/playback-progress-direct-narrow.png' });
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.getByRole('button', { name: 'Switch base to template', exact: true }).click();
	await page.getByRole('combobox', { name: 'Base template', exact: true }).selectOption(template.id);
	await expect(progress).toHaveCount(0);
	await page.getByRole('button', { name: 'Switch base to program', exact: true }).click();
	await expect(progress).toBeVisible();
	await page.getByRole('button', { name: 'Add Conditional Template', exact: true }).click();
	await expect(progress).toHaveCount(0);
	await page.getByRole('button', { name: 'Switch conditional layer to program', exact: true }).click();
	await expect(progress).toBeVisible();
	await page.getByRole('button', { name: 'Switch conditional layer to template', exact: true }).click();
	await expect(progress).toHaveCount(0);
	await page.getByRole('button', { name: 'Reset', exact: true }).click();
	await page.getByRole('button', { name: 'Confirm Reset', exact: true }).click();
	await expect(progress).toBeVisible();
	await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
});

test('saves playback progress values and changes guide listings without changing playback', async ({ page, documentationServer }) => {
	const { template, program } = await seedSchedule(page, documentationServer.directory);
	const read = async (): Promise<ScheduleTemplate> => (await page.request.get(`/api/v1/schedule-templates/${template.id}`)).json();
	const original = await read();
	for (const scope of ['occurrence', 'persistent']) {
		await page.goto(`/schedules/templates/${template.id}`);
		const progress = page.getByRole('combobox', { name: 'Playback progress', exact: true });
		const advanced = page.getByRole('button', { name: 'Advanced scheduling behavior', exact: true });
		await expect(advanced).toBeVisible();
		if (await advanced.getAttribute('aria-expanded') !== 'true') {
			await advanced.click();
		}
		await expect(progress).toBeVisible();
		await progress.selectOption(scope);
		if (scope === 'occurrence') {
			await page.setViewportSize({ width: 390, height: 844 });
			await progress.scrollIntoViewIfNeeded();
			await expect(progress).toBeVisible();
			await page.screenshot({ path: 'test-results/playback-progress-template-narrow.png' });
			await page.setViewportSize({ width: 1440, height: 900 });
		}
		await page.getByRole('button', { name: 'Save', exact: true }).click();
		await expect(page).toHaveURL(/\/schedules\/templates(?:\?.*)?$/);
		expect((await read()).slots[0]!.stateScope).toBe(scope);
	}
	// Guide presentation changes leave the complete playback definition intact.
	for (const mode of ['block', 'items']) {
		await page.goto(`/schedules/templates/${template.id}`);
		await page.getByRole('combobox', { name: 'Show in guide', exact: true }).selectOption(mode);
		if (mode === 'block') {
			await page.getByRole('textbox', { name: 'Guide title', exact: true }).fill('Cinema block');
			await expect(page.locator('.resolved-guide-block')).toHaveCount(1);
		}
		else {
			await expect(page.locator('.resolved-guide-block')).toHaveCount(0);
			await expect(page.locator('.resolved-segment.role-primary').first()).toBeVisible();
		}
		await page.getByRole('button', { name: 'Save', exact: true }).click();
		await expect(page).toHaveURL(/\/schedules\/templates(?:\?.*)?$/);
		const saved = await read();
		expect(playbackSlots(saved)).toEqual(playbackSlots(original));
		expect(saved.boundaries).toEqual(original.boundaries);
		expect(saved.slots[0]!.guide?.mode).toBe(mode);
	}

	await page.goto(`/schedules/programs/${program.id}`);
	await page.setViewportSize({ width: 390, height: 844 });
	await page.locator('.program-playback-state').scrollIntoViewIfNeeded();
	await page.screenshot({ path: 'test-results/playback-progress-program-narrow.png' });
	await page.goto('/schedules/programs/new');
	await page.getByRole('radio', { name: /^Sequence/u }).check();
	await page.locator('.program-playback-state').scrollIntoViewIfNeeded();
	await page.screenshot({ path: 'test-results/playback-progress-sequence-narrow.png' });
});
