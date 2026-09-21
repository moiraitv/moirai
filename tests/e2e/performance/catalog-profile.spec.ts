import { expect, test } from '@playwright/test';
import { schedulingProgramSchema, scheduleTemplateSchema } from '@moirai/shared/api-contracts';
import { SECONDS_PER_SCHEDULING_DAY } from '@moirai/shared';
import { installGuideFixture } from './guide-fixture';
import { saveProfile } from './profile-output';

// Trace snapshots traverse the whole DOM and distort browser CPU measurements.
test.use({ trace: 'off' });

test('profiles large scheduling catalogs and program editor navigation', async ({ page }, testInfo) => {
	await installGuideFixture(page, 20);
	const libraryId = '00000000-0000-4000-8000-000000000001';
	const programs = Array.from({ length: 5000 }, (_, index) => schedulingProgramSchema.parse({
		id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
		name: `The Program ${(index * 7919) % 5000}`,
		config: { type: 'content', source: { type: 'library-query', libraryId }, strategy: { type: 'sequential' } },
		createdAt: '2026-09-20T00:00:00Z', updatedAt: '2026-09-20T00:00:00Z',
	}));
	const templates = programs.slice(0, 100).map(program => scheduleTemplateSchema.parse({
		id: program.id, name: program.name.replace('Program', 'Template'),
		slots: [{ id: libraryId, startSeconds: 0, programId: program.id, filler: { mode: 'disabled' } }],
		boundaries: [{ id: libraryId, leftSlotId: libraryId, rightSlotId: libraryId, targetSeconds: SECONDS_PER_SCHEDULING_DAY, policy: 'hard' }],
		createdAt: program.createdAt, updatedAt: program.updatedAt,
	}));
	await page.route('**/api/v1/scheduling/overview', route => route.fulfill({ json: { programs, templates, programStatuses: [], channelSchedules: [] } }));
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	const samples = [];
	for (const [path, selector] of [['/schedules/programs', '.program-row'], ['/schedules/templates', '.template-row']] as const) {
		const start = performance.now();
		await page.goto(path);
		await expect(page.locator(selector).first()).toBeVisible();
		samples.push({ path, load: performance.now() - start, rendered: await page.locator(selector).count() });
	}
	await page.goto('/schedules/programs');
	await expect(page.locator('.program-row').first()).toBeVisible();
	const start = performance.now();
	await page.getByRole('searchbox', { name: 'Search programs' }).fill('Program 49');
	await expect(page).toHaveURL(/q=Program\+49/);
	await page.locator('.program-row a').first().click();
	await expect(page.getByRole('dialog', { name: 'Edit Program' })).toBeVisible();
	await page.getByRole('button', { name: 'Close program editor' }).click();
	await expect(page.getByRole('dialog')).toBeHidden();
	samples.push({ filterAndEditor: performance.now() - start });
	console.log(JSON.stringify({ catalogs: samples, errors }));
	await saveProfile(testInfo, 'catalog-profile', { samples, errors });
	expect(errors).toEqual([]);
});
