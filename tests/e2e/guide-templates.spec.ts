import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { channelCreateSchema } from '@moirai/shared';
import { authenticateAdministrator } from './authentication';

test('inspects inherited Program metadata from a compact guide preview', async ({ page }) => {
	await authenticateAdministrator(page);
	const startDate = '2026-11-11';
	const start = `${startDate}T00:00:00Z`;
	const channel = { ...channelCreateSchema.parse({ number: '12', name: 'Showcase TV' }),
		id: randomUUID(), createdAt: start, updatedAt: start };
	const parent = randomUUID();
	const child = randomUUID();
	const title = 'Evening Feature';
	const entry = { id: randomUUID(), channelId: channel.id, kind: 'item', start, finish: '2026-11-12T00:00:00Z',
		title, description: '', programId: child, segmentId: null, occurrenceId: null, role: 'primary', truncated: false };
	await page.route('**/api/v1/channels', route => route.fulfill({ json: [channel] }));
	await page.route('**/api/v1/guide-templates/preview', route => route.fulfill({ json: {
		startDate, timeZone: 'UTC', entries: [entry], channelValues: [],
		listingValues: { [entry.id]: [{ name: 'title', value: title }] },
		programMetadata: {
			byId: { [parent]: { label: 'Parent label', lineup: 'Double Feature' }, [child]: { label: '' } },
			listingProgramIds: { [entry.id]: [parent, child] },
		},
	} }));

	await page.goto('/playback/guide-templates');
	await page.getByRole('button', { name: 'New template', exact: true }).click();
	await page.getByRole('button', { name: /^Evening Feature,/ }).click();
	const inspector = page.getByRole('dialog', { name: 'Liquid values' });
	await expect(inspector.getByText('program.metadata.lineup', { exact: true })).toBeVisible();
	await expect(inspector.getByText('Double Feature', { exact: true })).toBeVisible();
	await expect(inspector.getByText('program.metadata.label', { exact: true })).toBeVisible();
	await expect(inspector.getByText('""', { exact: true })).toBeVisible();
	await expect(inspector.getByText('Parent label', { exact: true })).toHaveCount(0);
});
