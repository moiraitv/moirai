import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from '../documentation/fixture';
import { expect } from '@playwright/test';
import { seedSchedule } from '../documentation/seed';
import type { Page } from '@playwright/test';

const evidenceRoot = path.resolve('docs/design-language/images/source-audit');
const observations: { scene: string; headings: string[]; buttons: string[]; links: string[] }[] = [];

async function evidence(page: Page, scene: string): Promise<void> {
	await page.evaluate(async () => {
		await document.fonts.ready;
		await Promise.all([...document.images].filter(image => image.complete && image.naturalWidth).map(image => image.decode().catch(() => {})));
	});
	await page.screenshot({ path: path.join(evidenceRoot, `${scene}.png`), animations: 'disabled' });
	observations.push({
		scene,
		headings: await page.getByRole('heading').allTextContents(),
		buttons: await page.getByRole('button').evaluateAll(elements => elements.map(element => element.getAttribute('aria-label') ?? element.textContent?.trim() ?? '')),
		links: await page.getByRole('link').allTextContents(),
	});
}

test('capture current source in an isolated seeded application, without publishing docs', async ({ page, documentationServer }) => {
	await mkdir(evidenceRoot, { recursive: true });
	const { libraryId, channel, program, sequenceProgramIds, requestHeaders } = await seedSchedule(page, documentationServer.directory);
	await evidence(page, 'library');
	await page.getByRole('button', { name: 'Select items', exact: true }).click();
	await page.getByRole('button', { name: 'Select Afterlight Station', exact: true }).click();
	await evidence(page, 'library-bulk');
	await page.getByRole('button', { name: 'Cancel selection', exact: true }).click();
	await page.getByRole('button', { name: 'Filter media', exact: true }).click();
	await evidence(page, 'library-filter');
	await page.keyboard.press('Escape');
	await page.getByRole('button', { name: 'Last scan: open scan history', exact: true }).click();
	await expect(page.getByRole('dialog', { name: 'Scan history' })).toBeVisible();
	await evidence(page, 'library-history');
	await page.keyboard.press('Escape');
	await page.goto('/schedules/programs');
	await expect(page.getByRole('heading', { name: 'Programs', exact: true })).toBeVisible();
	await evidence(page, 'catalog');
	await page.getByText('Midnight Feature Collection', { exact: true }).first().click();
	await expect(page.getByRole('button', { name: 'Close program inspector' })).toBeVisible();
	await evidence(page, 'inspector');
	await page.goto(`/schedules/programs/${program.id}`);
	await expect(page.getByRole('heading', { name: 'Edit Program', exact: true })).toBeVisible();
	await evidence(page, 'program-editor');
	const sequenceResponse = await page.request.post('/api/v1/programs', { headers: requestHeaders, data: {
		name: 'Audit Sequence', config: { type: 'sequence', repeat: true, ordering: { type: 'ordered' }, entries: sequenceProgramIds.map(programId => ({ id: randomUUID(), programId, count: 1 })) },
	} });
	expect(sequenceResponse.ok()).toBe(true);
	const sequence = await sequenceResponse.json() as { id: string };
	await page.goto(`/schedules/programs/${sequence.id}`);
	await expect(page.getByRole('region', { name: 'Sequence guide preview', exact: true })).toBeVisible();
	await evidence(page, 'sequence-editor');
	await page.goto('/settings');
	await expect(page.getByRole('heading', { name: 'Playback capacity' })).toBeVisible();
	await evidence(page, 'settings');
	for (const tab of ['AI', 'Backups']) {
		await page.getByRole('tab', { name: tab, exact: true }).click();
		await evidence(page, `settings-${tab.toLowerCase()}`);
	}
	await page.goto('/channels');
	await page.getByRole('button', { name: 'Edit Moonrise Classics', exact: true }).click();
	await evidence(page, 'channel-editor');
	const channelDialog = page.getByRole('dialog', { name: 'Edit Channel', exact: true });
	await channelDialog.locator('input[type="file"]').first().setInputFiles(path.resolve('tests/e2e/fixtures/user-documentation/afterlight-station-poster.png'));
	await expect(page.getByRole('img', { name: 'Channel logo crop preview', exact: true })).toBeVisible();
	await evidence(page, 'channel-logo-crop');
	await page.getByRole('button', { name: 'Remove selected logo', exact: true }).click();
	await page.getByRole('button', { name: 'Confirm remove selected logo', exact: true }).click();
	await page.keyboard.press('Escape');
	await page.goto('/schedules/channels');
	await expect(page.getByRole('heading', { name: 'Channel Schedules', exact: true })).toBeVisible();
	await evidence(page, 'schedules');
	await page.goto('/guide');
	await expect(page.getByRole('heading', { name: 'Guide', exact: true })).toBeVisible();
	await evidence(page, 'guide');
	await page.goto('/logs');
	await expect(page.getByRole('heading', { name: 'Logs', exact: true })).toBeVisible();
	await evidence(page, 'logs');
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto(`/libraries/${libraryId}`);
	await evidence(page, 'mobile-library');
	await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
	await evidence(page, 'mobile-navigation');
	await page.keyboard.press('Escape');
	await page.goto(`/schedules/channels/${channel.id}`);
	await evidence(page, 'mobile-schedule-editor');
	await writeFile(path.join(evidenceRoot, 'observations.json'), `${JSON.stringify(observations, null, 2)}\n`);
});
