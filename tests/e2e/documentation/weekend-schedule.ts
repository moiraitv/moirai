import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect } from '@playwright/test';
import { SECONDS_PER_SCHEDULING_DAY, type MediaSourcePickerResult } from '@moirai/shared';
import { authenticateAdministrator } from '../authentication';
import { waitForLibraryScan } from '../library-scan';
import { test } from './fixture';
import { capture, registerProgramColors } from './capture';

test('captures the weekend morning template and channel schedule recipe', { tag: '@docs-screenshot' }, async ({ page, documentationServer }) => {
	const headers = { 'x-moirai-csrf': await authenticateAdministrator(page) };
	const names = ['Acorn Adventures', 'Bumble Brigade', 'Cloud Club'];
	const root = path.join(documentationServer.directory, 'cartoons');
	for (const name of names) {
		const directory = path.join(root, name, 'Season 01');
		await mkdir(directory, { recursive: true });
		for (const episode of ['01', '02', '03']) {
			await writeFile(path.join(directory, `${name} S01E${episode}.mp4`), 'documentation fixture');
		}
	}
	const libraryResponse = await page.request.post('/api/v1/libraries', { headers, data: {
		name: 'Cartoons', typeKey: 'shows', sourceType: 'on-disk', sourceConfig: { scanRoot: root }, watcherEnabled: false,
	} });
	expect(libraryResponse.ok()).toBe(true);
	const libraryId = (await libraryResponse.json() as { id: string }).id;
	await waitForLibraryScan(page, libraryId);
	const sources = await (await page.request.get(`/api/v1/libraries/${libraryId}/media-source-options?target=groups`)).json() as MediaSourcePickerResult;
	const children: string[] = [];
	for (const name of names) {
		const group = sources.entries.find(entry => entry.group?.title === name)?.group;
		expect(group).toBeDefined();
		const response = await page.request.post('/api/v1/programs', { headers, data: { name, config: {
			type: 'content', source: { type: 'group-collection', libraryId, groupIds: [group!.id] }, strategy: { type: 'sequential' },
		} } });
		expect(response.ok()).toBe(true);
		children.push((await response.json() as { id: string }).id);
	}

	// Both sequences follow the guide's counts, with independent child episode progress.
	const programs: string[] = [];
	for (const [name, ordering] of [
		['Cartoon Lineup', { type: 'shuffled-allocations', seed: '' }],
		['Weekend Cartoon Blocks', { type: 'ordered' }],
	] as const) {
		const response = await page.request.post('/api/v1/programs', { headers, data: { name, config: {
			type: 'sequence', repeat: true, ordering,
			entries: children.map((programId, index) => ({ id: randomUUID(), programId, count: 3 - index })),
		} } });
		expect(response.ok()).toBe(true);
		programs.push((await response.json() as { id: string }).id);
	}
	registerProgramColors(page, programs);
	const templates: string[] = [];
	for (const [index, name] of ['Cartoon Day', 'Weekend Morning'].entries()) {
		const slots = (index === 0 ? [0] : [0, 8 * 3600, 12 * 3600]).map((startSeconds, slotIndex) => ({
			id: randomUUID(), startSeconds, programId: index === 0 ? programs[0] : slotIndex === 1 ? programs[1] : null,
			filler: { mode: 'disabled' }, stateScope: 'persistent', startEligibility: { type: 'allow-overrun' },
		}));
		const response = await page.request.post('/api/v1/schedule-templates', { headers, data: {
			name, slots, boundaries: slots.map((slot, slotIndex) => ({
				id: randomUUID(), leftSlotId: slot.id, rightSlotId: slots[(slotIndex + 1) % slots.length]!.id,
				targetSeconds: slots[slotIndex + 1]?.startSeconds ?? SECONDS_PER_SCHEDULING_DAY,
				policy: 'finish-left', maxDriftSeconds: null,
			})),
		} });
		expect(response.ok(), await response.text()).toBe(true);
		templates.push((await response.json() as { id: string }).id);
	}

	await page.setViewportSize({ width: 1440, height: 1200 });
	await page.goto(`/schedules/templates/${templates[1]}`);
	await expect(page.locator('.template-slot')).toHaveCount(3);
	await page.locator('.template-slot').nth(1).click();
	await expect(page.locator('.template-slot-fields').getByRole('combobox', { name: /^Program\b/ })).toHaveValue(programs[1]!);
	await capture(page, 'example-weekend-template.png');

	const channelResponse = await page.request.post('/api/v1/channels', { headers, data: { number: '8', name: 'Cartoon Channel' } });
	expect(channelResponse.ok()).toBe(true);
	const channelId = (await channelResponse.json() as { id: string }).id;
	const response = await page.request.put(`/api/v1/channels/${channelId}/schedule`, { headers, data: {
		defaultTemplateId: templates[0], layers: [{
			id: randomUUID(), templateId: templates[1], predicate: { type: 'weekdays', values: [6, 7] },
			entryBoundary: { policy: 'finish-left', maxDriftSeconds: null },
			exitBoundary: { policy: 'finish-left', maxDriftSeconds: null },
		}],
	} });
	expect(response.ok(), await response.text()).toBe(true);
	await page.goto(`/schedules/channels/${channelId}`);
	await page.locator('.schedule-layer').filter({ hasText: 'Weekend Morning' }).click();
	await expect(page.getByRole('checkbox', { name: 'Sat', exact: true })).toBeChecked();
	await expect(page.getByRole('checkbox', { name: 'Sun', exact: true })).toBeChecked();
	await page.getByLabel('Preview date', { exact: true }).fill('2026-01-17');
	await page.getByLabel('Preview date', { exact: true }).blur();
	await page.getByRole('button', { name: 'Refresh Now', exact: true }).click();
	await expect(page.locator('.scheduling-preview-dock .resolved-segment.role-primary').first()).toBeVisible();
	await page.locator('.scheduling-workspace-scroll').evaluate(element => {
		element.scrollTop = 0; 
	});
	await capture(page, 'example-weekend-schedule.png');
});
