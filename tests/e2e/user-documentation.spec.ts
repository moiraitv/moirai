import './documentation/duration-filters';
import { randomUUID } from 'node:crypto';
import { rename, mkdir, writeFile, copyFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { expect } from '@playwright/test';
import { SECONDS_PER_SCHEDULING_DAY, type ScheduleTemplate } from '@moirai/shared';
import { authenticateAdministrator, E2E_ADMIN_USERNAME, E2E_ADMIN_PASSWORD } from './authentication';
import { test } from './documentation/fixture';
import { serveReviewFixture } from './documentation/review-fixture';
import { capture, captureSection, assertProgramColors } from './documentation/capture';
import { seedLibrary, seedSchedule, normalizeFixtureLogs } from './documentation/seed';
import { seedSemanticCache } from './documentation/semantic';
import { helpReviewLabel, type HelpReviewReason } from '../../apps/web/src/help-review';
import MarkdownIt from 'markdown-it';
import { userDocsTermBadges } from '../../scripts/user-docs-term-badges';

test('captures setup and authentication', { tag: '@docs-screenshot' }, async ({ page }) => {
	await page.goto('/setup');
	await expect(page.getByRole('heading', { name: 'Create user' })).toBeVisible();
	await capture(page, 'administrator-setup.png');

	await page.getByLabel('Username', { exact: true }).fill(E2E_ADMIN_USERNAME);
	await page.getByLabel('New password').fill(E2E_ADMIN_PASSWORD);
	await page.getByLabel('Confirm password', { exact: true }).fill(E2E_ADMIN_PASSWORD);
	await page.getByRole('button', { name: 'Create User', exact: true }).click();
	await expect(page.getByRole('heading', { name: 'Create user', exact: true })).toBeHidden();
	await page.goto('/');
	await expect(page.getByRole('heading', { name: 'Status' })).toBeVisible();
	await capture(page, 'dashboard.png');

	await page.goto('/libraries');
	await expect(page.getByText('Build your first library')).toBeVisible();
	await capture(page, 'libraries.png');
	await page.getByRole('button', { name: 'Add Library', exact: true }).first().click();
	await capture(page, 'library-create.png');
	await page.getByRole('button', { name: 'Close library editor' }).click();

});
test('captures libraries and scanning', { tag: '@docs-screenshot' }, async ({ page, documentationServer }) => {
	const { libraryId, mediaRoot } = await seedLibrary(page, documentationServer.directory, true);
	await capture(page, 'library-catalog.png');
	const historyTrigger = page.getByRole('button', { name: 'Last scan: open scan history' });
	await historyTrigger.click();
	const history = page.getByRole('dialog', { name: 'Scan history' });
	await expect(history.locator('article').first()).toBeVisible();
	await capture(page, 'library-scan-history.png');
	await page.keyboard.press('Escape');
	await expect(history).toBeHidden();
	await expect(historyTrigger).toBeFocused();
	await historyTrigger.press('Enter');
	await history.getByRole('button', { name: 'Close scan history' }).click();
	await expect(history).toBeHidden();

	// The footer stays at the viewport edge at either end of the catalog on desktop and mobile.
	for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
		await page.setViewportSize(viewport);
		for (const bottom of [false, true]) {
			await page.evaluate((atBottom) => window.scrollTo({ top: atBottom ? document.body.scrollHeight : 0, behavior: 'instant' }), bottom);
			await expect.poll(async () => {
				const bounds = await page.locator('.catalog-footer').boundingBox();
				return bounds ? Math.abs(bounds.y + bounds.height - viewport.height) : Infinity;
			}).toBeLessThan(2);
			await expect(page.getByRole('button', { name: 'Next page', exact: true })).toBeVisible();
		}
	}
	await page.setViewportSize({ width: 1440, height: 900 });

	await page.goto(`/libraries/${libraryId}?q=Drama`);
	await expect(page.locator('.media-card-match').first()).toContainText('Genre');
	await capture(page, 'library-search.png');
	await page.goto(`/libraries/${libraryId}`);
	await expect(page.getByRole('link', { name: /Afterlight Station/ }).first()).toBeVisible();
	await page.getByRole('button', { name: 'Select items', exact: true }).click();
	await page.getByRole('button', { name: 'Select Afterlight Station', exact: true }).click();
	await page.getByRole('button', { name: 'Select Checkout Please', exact: true }).click();
	await expect(page.getByText('2 selected', { exact: true })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Add Selected', exact: true })).toBeEnabled();
	await page.getByRole('heading', { name: 'Evening Cinema' }).hover();
	await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
	await capture(page, 'library-selection.png');
	await page.getByRole('button', { name: 'Cancel selection', exact: true }).click();

	await rename(mediaRoot, `${mediaRoot}-offline`);
	try {
		await page.goto(`/libraries/${libraryId}`);
		await expect(page.getByText('Media source may be offline', { exact: true })).toBeVisible();
		// Reveal the status surface above the catalog's restored scroll position.
		await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
		await expect(page.locator('.source-outage-banner')).toBeInViewport();
		await expect.poll(() => page.evaluate(() => {
			const header = document.querySelector('.library-page-header')!.getBoundingClientRect();
			const warning = document.querySelector('.source-outage-banner')!.getBoundingClientRect();
			return { belowHeader: warning.top >= header.bottom - 1, withinViewport: warning.bottom <= window.innerHeight + 1 };
		})).toEqual({ belowHeader: true, withinViewport: true });
		await capture(page, 'library-offline.png');
	}
	finally {
		await rename(`${mediaRoot}-offline`, mediaRoot);
	}
	await page.reload();
	await expect(page.getByRole('heading', { name: 'Evening Cinema' })).toBeVisible();
	await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));

	await page.getByRole('button', { name: 'Filter media', exact: true }).click();
	const filters = page.getByRole('dialog', { name: 'Filter media' });
	await expect(filters).toBeVisible();
	await expect(filters).toHaveCSS('opacity', '1');
	await expect.poll(async () => {
		const bounds = await filters.boundingBox();
		return Boolean(bounds && bounds.y >= 0 && bounds.y + bounds.height <= page.viewportSize()!.height);
	}).toBe(true);
	await filters.locator('.filter-modal-body').evaluate(element => element.scrollTo({ top: 0, behavior: 'instant' }));
	await capture(page, 'library-filters.png');
	await filters.getByRole('button', { name: 'Cancel', exact: true }).click();
	await expect(filters).toBeHidden();

	await page.getByRole('link', { name: /Moonrise Theater/u }).first().click();
	await expect(page.getByRole('heading', { name: 'Moonrise Theater' })).toBeVisible();

	await page.goto('/quick');
	await page.getByRole('button', { name: /Movie Channel/u }).click();
	await page.getByRole('combobox', { name: 'Library', exact: true }).selectOption(libraryId);
	await page.locator('#quick-setup-actions').getByRole('button', { name: 'Continue', exact: true }).click();
	await expect(page.getByRole('heading', { name: 'Choose the programming' })).toBeVisible();
	await expect(page.locator('.quick-query-carousel-item').first()).toBeVisible();
	await expect(page.locator('.quick-step')).not.toHaveClass(/quick-step-enter/u);
	await expect(page.locator('.quick-step')).toHaveCSS('opacity', '1');
	await capture(page, 'quick-setup.png');
	await page.getByRole('button', { name: 'Close Quick Setup' }).click();
	const discardSetup = page.getByRole('alertdialog', { name: 'Leave Quick Setup?' });
	if (await discardSetup.isVisible()) {
		await discardSetup.getByRole('button', { name: /Discard/u }).click();
	}

});
test('captures Programs', { tag: '@docs-screenshot' }, async ({ page, documentationServer }) => {
	const { libraryId, sequenceProgramIds } = await seedSchedule(page, documentationServer.directory);
	await page.goto('/schedules/programs');
	await expect(page.getByRole('heading', { name: 'Programs', exact: true })).toBeVisible();
	await page.locator(`[data-program-id="${sequenceProgramIds[1]}"]`).click();
	await expect(page.locator('.program-inspector')).toBeVisible();
	await capture(page, 'programs.png');
	await page.goto('/schedules/programs/new');
	await expect(page.getByRole('dialog', { name: 'Create Program' })).toBeVisible();
	await page.getByPlaceholder('e.g. Primetime Movies').fill('Evening Cinema Selection');
	await page.getByRole('combobox', { name: 'Library', exact: true }).selectOption(libraryId);
	await expect(page.locator('.quick-query-carousel-item').first()).toBeVisible();
	await capture(page, 'program-content-create.png');
	const subtitles = page.locator('.program-subtitle-disclosure');
	await subtitles.getByRole('button', { name: /Audio and subtitles/ }).click();
	await expect(subtitles.getByRole('combobox', { name: 'Music video credits', exact: true })).toBeEnabled();
	await captureSection(page, subtitles, 'program-subtitles.png');
	await subtitles.getByRole('button', { name: /Audio and subtitles/ }).click();

	await page.getByRole('radio', { name: /^Sequence/u }).check();
	await expect(page.getByRole('dialog', { name: 'Create Program' })).toBeVisible();
	await page.getByPlaceholder('e.g. Evening Lineup').fill('Evening Cinema Sequence');
	for (const [index, programId] of sequenceProgramIds.entries()) {
		await page.getByRole('button', { name: 'Add Step', exact: true }).click();
		await page.locator('.sequence-entry select').nth(index).selectOption(programId);
		await page.locator('.sequence-entry input').nth(index).fill(index === 0 ? '2' : '1');
	}
	await expect(page.locator('.sequence-entry')).toHaveCount(3);
	await capture(page, 'program-sequence-create.png');

	seedSemanticCache(documentationServer.directory);
	await page.getByRole('radio', { name: /^Theme/u }).check();
	await page.getByPlaceholder('e.g. Evening Lineup').fill('Space discovery');
	await page.getByLabel('Theme', { exact: true }).fill('Space exploration and first contact');
	await expect(page.getByRole('region', { name: 'Sample matches' }).getByRole('link').first()).toBeVisible();
	await capture(page, 'program-theme-create.png');
	await page.getByRole('radio', { name: /^Similar Items/u }).check();
	await page.getByLabel('Source Program', { exact: true }).selectOption(sequenceProgramIds[1]!);
	await page.getByPlaceholder('e.g. Evening Lineup').fill('Related Cinema');
	await page.getByLabel('Exclusions', { exact: true }).fill('superhero movies');
	await page.getByLabel('Exclusions', { exact: true }).blur();
	await expect(page.getByLabel('Exclusion strictness', { exact: true })).toBeVisible();
	await expect(page.getByRole('region', { name: 'Sample matches' }).getByRole('link').first()).toBeVisible();
	await capture(page, 'program-similarity-create.png');
	await page.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(page.getByRole('dialog')).toBeHidden();
	const similarRow = page.locator('.program-management-row').filter({ has: page.getByRole('button', { name: /^Related Cinema/ }) });
	await expect(similarRow.locator('.program-mini-preview')).toHaveCSS('display', 'flex');
	await similarRow.screenshot({ path: 'test-results/program-similarity-list.png' });
	await similarRow.getByRole('button', { name: /^Related Cinema/ }).click();
	await page.locator('.program-inspector').getByRole('link', { name: 'Edit Program', exact: true }).click();
	await expect(page.getByLabel('Source Program', { exact: true })).toHaveJSProperty('readOnly', true);
	const sample = page.getByRole('dialog').getByRole('region', { name: 'Sample matches' });
	await expect(sample.getByRole('link').first()).toBeVisible();
	await expect(sample.locator('.program-carousel')).toHaveCSS('display', 'flex');
	const quantity = await page.getByLabel('Quantity', { exact: true }).boundingBox();
	const carousel = await sample.locator('.program-carousel').boundingBox();
	expect(carousel!.x).toBe(quantity!.x);
	await page.screenshot({ path: 'test-results/program-similarity-edit.png' });

});
test('sorts Programs by name ignoring leading articles and punctuation', async ({ page, documentationServer }) => {
	const { libraryId, mediaIds, requestHeaders } = await seedLibrary(page, documentationServer.directory);
	for (const name of ['There Sort', 'A Quiet Sort', "The 'Burbs Sort", 'banana Sort', 'An Education Sort']) {
		const response = await page.request.post('/api/v1/programs', {
			headers: requestHeaders,
			data: {
				name,
				config: {
					type: 'content',
					source: { type: 'collection', libraryId, itemIds: mediaIds },
					strategy: { type: 'sequential' },
				},
			},
		});
		expect(response.ok(), await response.text()).toBe(true);
	}

	await page.goto('/schedules/programs');
	await expect(page.locator('.program-management-identity strong')).toHaveText([
		'banana Sort', "The 'Burbs Sort", 'An Education Sort', 'A Quiet Sort', 'There Sort',
	]);
	await page.getByRole('searchbox', { name: 'Search programs' }).fill('Sort');
	await expect(page.locator('.program-management-identity strong')).toHaveText([
		'banana Sort', "The 'Burbs Sort", 'An Education Sort', 'A Quiet Sort', 'There Sort',
	]);
});

test('sorts Templates by name ignoring leading articles and punctuation', async ({ page, documentationServer }) => {
	const { program, requestHeaders } = await seedSchedule(page, documentationServer.directory);
	for (const name of ['There Sort', 'A Quiet Sort', "The 'Burbs Sort", 'banana Sort', 'An Education Sort']) {
		const slotId = randomUUID();
		const response = await page.request.post('/api/v1/schedule-templates', {
			headers: requestHeaders,
			data: {
				name,
				slots: [{ id: slotId, startSeconds: 0, programId: program.id }],
				boundaries: [{
					id: randomUUID(), leftSlotId: slotId, rightSlotId: slotId,
					targetSeconds: SECONDS_PER_SCHEDULING_DAY, policy: 'hard',
				}],
			},
		});
		expect(response.ok(), await response.text()).toBe(true);
	}

	await page.goto('/schedules/templates');
	await expect(page.locator('.template-row-identity > a')).toHaveText([
		'banana Sort', "The 'Burbs Sort", 'An Education Sort', 'Evening Cinema Day', 'A Quiet Sort', 'There Sort',
	]);
	await page.getByRole('searchbox', { name: 'Search templates' }).fill('Sort');
	await expect(page.locator('.template-row-identity > a')).toHaveText([
		'banana Sort', "The 'Burbs Sort", 'An Education Sort', 'A Quiet Sort', 'There Sort',
	]);
});

test('saves new template defaults with unlimited finish-left boundaries', async ({ page, documentationServer }) => {
	await seedSchedule(page, documentationServer.directory);
	await page.goto('/schedules/templates/new');
	const editor = page.getByRole('dialog', { name: 'Template editor', exact: true });
	await editor.getByRole('textbox', { name: 'Template name' }).fill('Continuous default');
	await editor.getByRole('button', { name: 'Advanced scheduling behavior' }).click();
	await expect(editor.getByRole('combobox', { name: 'Item start rule', exact: true })).toHaveValue('allow-overrun');
	await expect(editor.getByRole('combobox', { name: 'Policy', exact: true })).toHaveValue('finish-left');
	await expect(editor.getByRole('button', { name: 'No Limit', exact: true })).toHaveAttribute('aria-pressed', 'true');
	await editor.getByRole('button', { name: 'Add Slot', exact: true }).click();
	await editor.locator('.template-timeline').press('Enter');

	const saved = page.waitForResponse(response => response.request().method() === 'POST'
		&& response.url().endsWith('/api/v1/schedule-templates'));
	await editor.getByRole('button', { name: 'Save', exact: true }).click();
	const response = await saved;
	expect(response.ok()).toBe(true);
	const template = await response.json() as ScheduleTemplate;
	expect(template.slots).toHaveLength(2);
	expect(template.slots.every(slot => slot.startEligibility.type === 'allow-overrun')).toBe(true);
	expect(template.boundaries).toHaveLength(2);
	expect(template.boundaries.every(boundary => boundary.policy === 'finish-left' && boundary.maxDriftSeconds === null)).toBe(true);
	await page.goto(`/schedules/templates/${template.id}`);
	await expect(editor.getByRole('combobox', { name: 'Item start rule', exact: true })).toHaveValue('allow-overrun');
	await expect(editor.getByRole('button', { name: 'No Limit', exact: true })).toHaveAttribute('aria-pressed', 'true');
});

test('captures Templates', { tag: '@docs-screenshot' }, async ({ page, documentationServer }) => {
	const { sequenceProgramIds } = await seedSchedule(page, documentationServer.directory);
	await page.goto('/schedules/templates');
	await expect(page.getByRole('heading', { name: 'Templates', exact: true })).toBeVisible();
	await capture(page, 'templates.png');
	// Capture the creation editors with representative values, leaving their drafts unsaved.
	await page.goto('/schedules/templates/new');
	const templateEditor = page.getByRole('dialog', { name: 'Template editor', exact: true });
	await expect(templateEditor.getByRole('heading', { name: 'Create Template', exact: true })).toBeVisible();
	await templateEditor.getByRole('textbox', { name: 'Template name' }).fill('Evening Cinema Day');
	await templateEditor.locator('.template-slot-fields').getByRole('combobox', { name: /^Program\b/u }).selectOption(sequenceProgramIds[0]!);
	for (const programId of sequenceProgramIds.slice(1)) {
		await templateEditor.getByRole('button', { name: 'Add Slot', exact: true }).click();
		await templateEditor.locator('.template-timeline').press('Enter');
		await templateEditor.locator('.template-slot-fields').getByRole('combobox', { name: /^Program\b/u }).selectOption(programId);
	}
	await expect(templateEditor.locator('.template-slot')).toHaveCount(3);
	await expect(templateEditor.locator('.resolved-segment').first()).toBeVisible({ timeout: 30_000 });
	await expect.poll(async () => templateEditor.evaluate((editor) => {
		const colors = (selector: string) => [...new Set(
			Array.from(editor.querySelectorAll(selector), (element) =>
				getComputedStyle(element).getPropertyValue('--program-color').trim()),
		)].sort();
		return JSON.stringify(colors('.template-slot')) === JSON.stringify(colors('.resolved-segment.role-primary'));
	})).toBe(true);
	await capture(page, 'template-editor.png');
	await templateEditor.getByRole('combobox', { name: 'Show in guide' }).selectOption('block');
	await templateEditor.getByRole('textbox', { name: 'Guide title', exact: true }).fill('Evening Cinema');
	await templateEditor.getByRole('textbox', { name: 'Guide description (optional)' }).fill('A selection of films for the evening.');
	await captureSection(page, templateEditor.getByRole('group', { name: 'Guide output', exact: true }), 'template-slot-guide.png');
	await templateEditor.getByRole('combobox', { name: 'Show in guide' }).selectOption('items');
	await assertProgramColors(page, sequenceProgramIds);
	await captureSection(page, templateEditor.locator('.resolved-preview'), 'template-preview.png');

	await templateEditor.getByRole('button', { name: 'Advanced scheduling behavior' }).click();
	const advanced = templateEditor.locator('.slot-advanced');
	await expect(advanced.getByRole('combobox', { name: 'Playback state', exact: true })).toBeVisible();
	await captureSection(page, advanced.getByTestId('slot-playback-fields'), 'template-slot-playback.png');
	await captureSection(page, advanced.getByRole('group', { name: /^Outgoing boundary/u }), 'template-slot-boundary.png');
	const filler = advanced.getByRole('group', { name: 'Filler', exact: true });
	await filler.getByRole('combobox', { name: 'Mode', exact: true }).selectOption('configured');
	await captureSection(page, filler, 'template-slot-filler.png');

});
test('suggests a matching first channel template and preserves a saved override', async ({ page, documentationServer }) => {
	const { channel, program, template, requestHeaders } = await seedSchedule(page, documentationServer.directory);
	const slotId = randomUUID();
	const created = await page.request.post('/api/v1/schedule-templates', {
		headers: requestHeaders,
		data: {
			name: 'Moonrise Classics Daily',
			slots: [{ id: slotId, startSeconds: 0, programId: program.id }],
			boundaries: [{
				id: randomUUID(), leftSlotId: slotId, rightSlotId: slotId,
				targetSeconds: SECONDS_PER_SCHEDULING_DAY, policy: 'hard',
			}],
		},
	});
	expect(created.ok()).toBe(true);
	const matching = await created.json() as ScheduleTemplate;
	await page.goto('/schedules/channels');
	await page.getByRole('link', { name: 'Add Template', exact: true }).click();
	const base = page.getByRole('combobox', { name: 'Base template', exact: true });
	await expect(base).toHaveValue(matching.id);
	await base.selectOption(template.id);
	const saved = page.waitForResponse(response => response.request().method() === 'PUT'
		&& response.url().endsWith(`/api/v1/channels/${channel.id}/schedule`));
	await page.getByRole('button', { name: 'Save', exact: true }).click();
	expect((await saved).ok()).toBe(true);
	await page.goto(`/schedules/channels/${channel.id}`);
	await expect(base).toHaveValue(template.id);
});

test('previews individual guide media on Guide and Channels while keeping click details', async ({ page, documentationServer }) => {
	const { channel, template, requestHeaders } = await seedSchedule(page, documentationServer.directory);
	const assigned = await page.request.put(`/api/v1/channels/${channel.id}/schedule`, {
		headers: requestHeaders, data: { defaultTemplateId: template.id },
	});
	expect(assigned.ok()).toBe(true);
	const previewRequests: string[] = [];
	page.on('request', request => {
		if (request.url().endsWith('/card-preview')) {
			previewRequests.push(request.url());
		}
	});
	for (const route of ['/guide', '/channels']) {
		await page.goto(route);
		const item = page.locator('button.guide-programme.role-primary').first();
		await expect(item).toBeVisible({ timeout: 30_000 });
		await page.locator('.guide-scroll').evaluate(element => {
			element.scrollLeft = 0;
		});
		const tooltip = page.getByRole('tooltip');
		await expect(tooltip).toHaveCount(0);
		await item.hover();
		await expect(tooltip.getByRole('heading')).toBeVisible();
		await expect(tooltip.locator('.media-card-preview-plot')).toBeVisible();
		await expect(tooltip.locator('img')).toBeVisible();
		await expect(page.getByRole('dialog', { name: 'Actual guide items' })).toHaveCount(0);
		await page.screenshot({ path: `test-results/guide-item-preview-${route.slice(1)}.png` });
		await page.mouse.move(0, 0);
		await expect(tooltip).toHaveCount(0);
		await item.focus();
		await expect(tooltip).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(tooltip).toHaveCount(0);
		await item.click();
		const detail = page.locator('.guide-preview-modal');
		await expect(detail).toBeVisible();
		await expect(detail.locator('#guide-preview-title')).not.toHaveText('Programme details');
		await expect(tooltip).toHaveCount(0);
		await detail.getByRole('button', { name: 'Close', exact: true }).click();
	}
	expect(previewRequests.length).toBeGreaterThanOrEqual(2);
});

test('captures Channel Schedules and Guide', { tag: '@docs-screenshot' }, async ({ page, documentationServer }) => {
	const { template, channel, sequenceProgramIds, requestHeaders } = await seedSchedule(page, documentationServer.directory);
	const scheduleResponse = await page.request.put(`/api/v1/channels/${channel.id}/schedule`, {
		headers: requestHeaders,
		data: { defaultTemplateId: template.id },
	});
	expect(scheduleResponse.ok(), await scheduleResponse.text()).toBe(true);
	await page.goto(`/schedules/channels/${channel.id}`);
	await expect(page.getByRole('dialog', { name: 'Channel schedule editor' })).toBeVisible({
		timeout: 30_000,
	});
	await expect(page.getByRole('heading', { name: 'Preview layered schedule' })).toBeVisible();
	await expect(page.locator('.scheduling-preview-dock .resolved-segment').first()).toBeVisible({
		timeout: 30_000,
	});
	await page.locator('.scheduling-workspace-scroll').evaluate((element) => {
		element.scrollTop = 0;
	});
	await capture(page, 'channel-schedules.png');

	// Capture the committed Guide only after the channel has real scheduled media.
	await page.goto('/guide');
	await expect(page.getByRole('heading', { name: 'Guide', exact: true })).toBeVisible();
	await expect(page.locator('.guide-programme.role-primary').first()).toBeVisible({ timeout: 30_000 });
	await expect(page.locator('.guide-programme-timespan').first()).toBeVisible();
	await expect(page.locator('.guide-programme-thumb').first()).toBeVisible();
	await capture(page, 'guide.png');
	// Show a grouped listing with real committed media and the matching hover-range markers.
	const originalTemplate = await (await page.request.get(`/api/v1/schedule-templates/${template.id}`)).json() as ScheduleTemplate;
	const grouped = await page.request.patch(`/api/v1/schedule-templates/${template.id}`, {
		headers: requestHeaders,
		data: { ...originalTemplate, slots: originalTemplate.slots.map(slot => ({
			...slot, guide: { mode: 'block', title: 'Evening Cinema', description: 'Classic films and new discoveries, all day.', boundary: 'scheduled' },
		})) },
	});
	expect(grouped.ok(), await grouped.text()).toBe(true);
	const guideBlock = page.locator('.guide-block').first();
	await expect(guideBlock).toBeVisible({ timeout: 30_000 });
	await guideBlock.locator('.guide-block-copy').scrollIntoViewIfNeeded();
	const trackBounds = (await page.locator('.guide-scroll').boundingBox())!;
	const blockBounds = (await guideBlock.boundingBox())!;
	const channelBounds = (await page.locator('.guide-channel-cell').first().boundingBox())!;
	const visibleLeft = Math.max(blockBounds.x, channelBounds.x + channelBounds.width);
	const visibleRight = Math.min(blockBounds.x + blockBounds.width, trackBounds.x + trackBounds.width);
	await guideBlock.hover({ position: {
		x: (visibleLeft + visibleRight) / 2 - blockBounds.x,
		y: blockBounds.height / 2,
	} });
	const guideHover = page.getByRole('dialog', { name: 'Actual guide items' });
	await expect(guideHover).toBeVisible();
	await expect(page.getByRole('tooltip')).toHaveCount(0);
	await expect(guideHover.locator('.guide-programme').first()).toBeVisible();
	await expect(page.locator('.guide-range-marker')).toHaveCount(2);
	await capture(page, 'guide-single-block.png');
	await page.keyboard.press('Escape');
	const restored = await page.request.patch(`/api/v1/schedule-templates/${template.id}`, { headers: requestHeaders, data: originalTemplate });
	expect(restored.ok(), await restored.text()).toBe(true);

	// Illustrate a weekend evening override and the controls governing its handoffs.
	const conditionalSlotId = randomUUID();
	const conditionalTemplateResponse = await page.request.post('/api/v1/schedule-templates', {
		headers: requestHeaders,
		data: {
			name: 'Weekend Cinema',
			slots: [{ id: conditionalSlotId, startSeconds: 0, programId: sequenceProgramIds[1] }],
			boundaries: [{ id: randomUUID(), leftSlotId: conditionalSlotId, rightSlotId: conditionalSlotId, targetSeconds: SECONDS_PER_SCHEDULING_DAY, policy: 'hard' }],
		},
	});
	expect(conditionalTemplateResponse.ok(), await conditionalTemplateResponse.text()).toBe(true);
	const conditionalTemplate = await conditionalTemplateResponse.json() as { id: string };
	await page.setViewportSize({ width: 1440, height: 1200 });
	await page.goto(`/schedules/channels/${channel.id}`);
	const channelEditor = page.getByRole('dialog', { name: 'Channel schedule editor' });
	await channelEditor.getByRole('button', { name: 'Add Conditional Template' }).click();
	await channelEditor.getByRole('combobox', { name: 'Conditional layer template' }).selectOption(conditionalTemplate.id);
	const predicates = channelEditor.locator('.schedule-layer-inspector > .predicate-node');
	for (const weekday of ['Mon', 'Tue', 'Wed', 'Thu', 'Fri']) {
		await predicates.getByRole('checkbox', { name: weekday, exact: true }).uncheck();
	}
	await predicates.getByRole('button', { name: 'Condition', exact: true }).click();
	const newWeekday = predicates.locator('.predicate-weekdays').filter({
		has: page.getByRole('checkbox', { name: 'Mon', exact: true }).and(page.locator(':checked')),
	});
	await newWeekday.getByRole('combobox', { name: 'Predicate type' }).selectOption('time-range');
	await predicates.getByLabel('Starts', { exact: true }).fill('18:00');
	await predicates.getByLabel('Ends', { exact: true }).fill('23:00');
	await predicates.getByLabel('Ends', { exact: true }).blur();
	await expect(channelEditor.locator('.resolved-segment').first()).toBeVisible({ timeout: 30_000 });
	await channelEditor.locator('.scheduling-workspace-scroll').evaluate((element) => {
		element.scrollTop = 0;
	});
	await capture(page, 'channel-schedule-conditional.png');
	await captureSection(page, predicates, 'channel-schedule-predicates.png');
	const entry = channelEditor.getByRole('group', { name: 'Entry boundary', exact: true });
	await entry.getByRole('combobox', { name: 'Boundary behavior' }).selectOption('finish-left');
	await entry.getByLabel(/^Maximum drift past boundary/u).fill('15');
	await entry.getByLabel(/^Maximum drift past boundary/u).blur();
	await page.setViewportSize({ width: 1440, height: 1200 });
	await captureSection(page, channelEditor.locator('.layer-boundary-grid'), 'channel-schedule-boundaries.png');

});
test('starts each new channel with encoding and additional subtitles collapsed', async ({ page }) => {
	await page.addInitScript(() => {
		localStorage.setItem('moirai.ui.disclosure.channel-encoding.v1', 'true');
		localStorage.setItem('moirai.ui.disclosure.channel-subtitles.v1', 'true');
	});
	await authenticateAdministrator(page);
	await page.goto('/channels');
	for (let attempt = 0; attempt < 2; attempt += 1) {
		await page.getByRole('button', { name: 'New Channel', exact: true }).click();
		const editor = page.getByRole('dialog', { name: 'Create Channel', exact: true });
		await expect(editor.getByRole('combobox', { name: 'Audio and video settings', exact: true })).toBeEnabled();
		const encoding = editor.getByRole('button', { name: /Video & audio settings/u });
		const subtitles = editor.getByRole('button', { name: /Additional subtitle settings/u });
		await expect(encoding).toHaveAttribute('aria-expanded', 'false');
		await expect(subtitles).toHaveAttribute('aria-expanded', 'false');
		await encoding.click();
		await subtitles.click();
		await expect(encoding).toHaveAttribute('aria-expanded', 'true');
		await expect(subtitles).toHaveAttribute('aria-expanded', 'true');
		await editor.getByRole('button', { name: 'Close channel editor', exact: true }).click();
		await expect(editor).toBeHidden();
	}
});

test('captures channel settings and operations', { tag: '@docs-screenshot' }, async ({ page, documentationServer }) => {
	await seedSchedule(page, documentationServer.directory);
	await page.goto('/channels');
	await expect(page.getByRole('heading', { name: 'Channels', exact: true })).toBeVisible();
	await capture(page, 'channels.png');
	await page.goto('/settings');
	await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
	await expect(page.locator('.fallback-filler-loading')).toBeHidden();
	await expect(page.locator('.fallback-filler-editor video')).toBeVisible();
	await capture(page, 'settings.png');
	await normalizeFixtureLogs(documentationServer.directory);
	await page.goto('/logs');
	await expect(page.getByRole('heading', { name: 'Logs', exact: true })).toBeVisible();
	await capture(page, 'logs.png');
	await page.goto('/account');
	await expect(page.getByRole('heading', { name: 'Account', exact: true })).toBeVisible();
	await capture(page, 'account.png');
	await page.setViewportSize({ width: 1440, height: 1200 });
	await page.goto('/channels');
	await page.getByRole('button', { name: 'Edit Moonrise Classics', exact: true }).click();
	const broadcastEditor = page.getByRole('dialog', { name: /(?:Edit|Create) Channel/, exact: true });
	await expect(broadcastEditor.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('Moonrise Classics');
	await expect(broadcastEditor.locator('.fallback-filler-loading')).toBeHidden();
	await expect(broadcastEditor.locator('.acceleration-prediction')).not.toHaveText('Checking…', { timeout: 45_000 });
	await capture(page, 'channel-editor.png');
	await captureSection(page, broadcastEditor.locator('.channel-logo-editor'), 'channel-editor-logo.png');
	await broadcastEditor.getByRole('button', { name: /Channel fallback override/ }).click();
	await captureSection(page, broadcastEditor.locator('.channel-fallback-disclosure'), 'channel-editor-fallback.png');
	await broadcastEditor.getByRole('button', { name: /Guide template override/ }).click();
	await captureSection(page, broadcastEditor.locator('.channel-guide-template-disclosure'), 'channel-editor-guide-template.png');
	await broadcastEditor.getByRole('combobox', { name: 'Audio and video settings', exact: true }).selectOption({ label: 'Custom' });
	await expect(broadcastEditor.getByLabel('Width', { exact: true })).toBeEnabled();
	await page.setViewportSize({ width: 1440, height: 1700 });
	await captureSection(page, broadcastEditor.locator('.channel-encoding-disclosure'), 'channel-editor-encoding.png');
	await page.setViewportSize({ width: 1440, height: 1200 });
	await captureSection(page, broadcastEditor.getByRole('group', { name: 'Video', exact: true }), 'channel-editor-video.png');
	await captureSection(page, broadcastEditor.getByRole('group', { name: 'Audio', exact: true }), 'channel-editor-audio.png');
	await captureSection(page, broadcastEditor.getByRole('group', { name: 'Audio selection', exact: true }), 'channel-editor-audio-selection.png');
	await captureSection(page, broadcastEditor.getByRole('group', { name: 'Subtitles', exact: true }), 'channel-editor-subtitles.png');
	await page.setViewportSize({ width: 390, height: 844 });
	await broadcastEditor.locator('.channel-encoding-disclosure .form-disclosure-trigger').scrollIntoViewIfNeeded();
	expect(await broadcastEditor.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
});
test('presents accessible contextual help with draft and failure states', async ({ page }) => {
	let reviewStatus = 'needs-review';
	await page.route('/help/contextual-help.json', (route) => route.fulfill({
		json: {
			version: 1,
			guideVersion: 'test',
			topics: {
				'scheduling.programs': {
					id: 'scheduling.programs',
					title: 'Programs',
					description: 'Choose media and playback order.',
					html: '<h2>Content Programs</h2><p>Select media.</p><h2>Sequence Programs</h2>',
					fullPath: '/help/scheduling/programs.html',
					reviewStatus,
				},
			},
		},
	}));
	await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' });
	await page.goto('/setup');
	await authenticateAdministrator(page);
	await page.goto('/schedules/programs');

	const helpButton = page.getByRole('button', { name: 'Help with Programs', exact: true });
	await expect(page.locator('.page-header').getByRole('button', { name: 'Help with Programs' })).toBeVisible();
	await expect(page.locator('.sidebar-footer').getByRole('link', { name: 'User Guide', exact: true })).toHaveAttribute('href', '/help/');
	await expect(page.locator('.sidebar-footer').getByRole('link', { name: 'User Guide', exact: true })).toHaveAttribute('target', '_blank');
	const guidePopup = page.waitForEvent('popup');
	await page.locator('.sidebar-footer').getByRole('link', { name: 'User Guide', exact: true }).click();
	const fullGuidePage = await guidePopup;
	await expect(fullGuidePage.getByRole('heading', { level: 1, name: /^Welcome to Moirai/u })).toBeVisible();
	await fullGuidePage.close();
	await helpButton.click();
	const drawer = page.getByRole('dialog');
	await expect(drawer).toBeFocused();
	await expect(drawer.getByRole('heading', { name: 'Programs', exact: true })).toBeVisible();
	await expect(drawer.getByText('Needs review', { exact: true })).toBeVisible();
	const close = drawer.getByRole('button', { name: 'Close help' });
	const fullGuide = drawer.getByRole('link', { name: 'Open full guide' });
	await close.focus();
	await page.keyboard.press('Shift+Tab');
	await expect(fullGuide).toBeFocused();
	await page.keyboard.press('Tab');
	await expect(close).toBeFocused();
	await expect(drawer.getByRole('link', { name: 'Open full guide' })).toHaveAttribute(
		'href',
		'/help/scheduling/programs.html',
	);
	const animationSeconds = await drawer.evaluate((element) =>
		Number.parseFloat(getComputedStyle(element).animationDuration));
	expect(animationSeconds).toBeLessThanOrEqual(0.001);

	await page.keyboard.press('Escape');
	await expect(drawer).toBeHidden();
	await expect(helpButton).toBeFocused();

	reviewStatus = 'reviewed';
	await helpButton.click();
	await expect(drawer.getByRole('heading', { name: 'Programs', exact: true })).toBeVisible();
	await expect(drawer.getByText('Needs review', { exact: true })).toHaveCount(0);
	await page.locator('.help-drawer-backdrop').click({ position: { x: 2, y: 2 } });
	await expect(drawer).toBeHidden();

	await page.route('/help/contextual-help.json', (route) => route.fulfill({ status: 503 }));
	await helpButton.click();
	await expect(drawer.getByRole('alert')).toContainText('Help returned 503');
	await drawer.getByRole('button', { name: 'Close help' }).click();
	await expect(drawer).toBeHidden();
});

test('shows matching review scope in the guide and drawer', async ({ page }) => {
	let reasons: HelpReviewReason[] = ['initial'];
	await page.route('/help/contextual-help.json', (route) => route.fulfill({ json: {
		version: 1, guideVersion: 'test',
		pages: [{ id: 'scheduling.programs', path: '/help/scheduling/programs.html', reviewStatus: 'needs-review', reviewReasons: reasons }],
		topics: { 'scheduling.programs': {
			id: 'scheduling.programs', title: 'Programs', description: 'Fixture instructions', html: '<p>Fixture instructions</p>',
			fullPath: '/help/scheduling/programs.html', reviewStatus: 'needs-review', reviewReasons: reasons,
		} },
	} }));
	await page.goto('/setup');
	await authenticateAdministrator(page);
	for (const changed of [
		['initial'], ['text'], ['screenshots'], ['icons'], ['text', 'screenshots'], ['screenshots', 'icons'], ['text', 'screenshots', 'icons'], ['unknown'],
	] as HelpReviewReason[][]) {
		reasons = changed;
		await page.goto('/help/scheduling/programs.html');
		await expect(page.locator('.review-banner > strong')).toHaveText(helpReviewLabel(reasons));
		await page.goto('/schedules/programs');
		await page.getByRole('button', { name: 'Help with Programs', exact: true }).click();
		await expect(page.getByRole('dialog').getByRole('status')).toContainText(helpReviewLabel(reasons));
		await page.keyboard.press('Escape');
	}
});

test('renders term badge structure without depending on HTML serialization', async ({ page }) => {
	const markdown = new MarkdownIt({ html: false }).use(userDocsTermBadges);
	await page.setContent(markdown.render('A **![](/icons/library.svg) Library** holds media. ![](/icons/library.svg) [Libraries and scanning](/libraries/managing-libraries)'));
	const boldBadge = page.locator('strong .docs-term-badge');
	await expect(boldBadge).toHaveText('Library');
	await expect(boldBadge.locator('img')).toHaveAttribute('src', '/icons/library.svg');
	await expect(page.getByRole('link')).toHaveAttribute('href', '/libraries/managing-libraries');
	await expect(page.getByRole('link').locator('.docs-term-badge')).toHaveText('Libraries');
	await expect(page.locator('p')).toHaveText('A Library holds media. Libraries and scanning');
});

test('marks pending guide menu items using the generated review state', async ({ page }) => {
	const response = await page.request.get('/help/contextual-help.json');
	expect(response.ok()).toBe(true);
	const manifest = await response.json() as { pages: Array<{ path: string; reviewStatus: string }> };
	await page.goto('/help/glossary.html');
	await expect(page.locator('.VPSidebar')).toBeVisible();
	for (const entry of manifest.pages) {
		const link = page.locator(`.VPSidebar a[href="${entry.path}"]`);
		if (await link.count()) {
			await expect(link.locator('.docs-menu-review-badge')).toHaveCount(entry.reviewStatus === 'needs-review' ? 1 : 0);
		}
	}
});

test('keeps guide title icons inline after production asset processing', async ({ page }) => {
	await page.goto('/help/scheduling/programs.html');
	const heading = page.locator('.vp-doc h1');
	await expect(heading.locator('img')).toBeVisible();
	const iconScale = await heading.evaluate((element) => element.querySelector('img')!.getBoundingClientRect().width / parseFloat(getComputedStyle(element).fontSize));
	expect(iconScale).toBeCloseTo(1.2, 1);
	const positions = await heading.evaluate((element) => {
		const icon = element.querySelector('img')!.getBoundingClientRect();
		const text = [...element.childNodes].find((node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim())!;
		const range = document.createRange();
		range.selectNodeContents(text);
		const label = range.getBoundingClientRect();
		return { iconRight: icon.right, iconTop: icon.top, iconBottom: icon.bottom, textLeft: label.left, textTop: label.top, textBottom: label.bottom };
	});
	expect(positions.iconRight).toBeLessThanOrEqual(positions.textLeft);
	expect(positions.iconTop).toBeLessThan(positions.textBottom);
	expect(positions.iconBottom).toBeGreaterThan(positions.textTop);
});

test('keeps guide badge icons compact after production asset processing', async ({ page }) => {
	await page.goto('/help/glossary.html');
	const badges = page.locator('.vp-doc .docs-term-badge');
	await expect(badges.first()).toBeVisible();
	const dimensions = await badges.evaluateAll((elements) => elements.map((badge) => {
		const icon = badge.querySelector('img')!;
		const fontSize = parseFloat(getComputedStyle(badge).fontSize);
		return {
			iconWidth: icon.getBoundingClientRect().width / fontSize,
			iconHeight: icon.getBoundingClientRect().height / fontSize,
			badgeHeight: badge.getBoundingClientRect().height / fontSize,
		};
	}));
	for (const dimensionsForBadge of dimensions) {
		expect(dimensionsForBadge.iconWidth).toBeCloseTo(1.4, 1);
		expect(dimensionsForBadge.iconHeight).toBeCloseTo(1.4, 1);
		expect(dimensionsForBadge.badgeHeight).toBeLessThan(2);
	}
});

test('captures music-video credit templates and verifies draft actions', { tag: '@docs-screenshot' }, async ({ page, documentationServer }) => {
	const csrf = await authenticateAdministrator(page);
	const root = path.join(documentationServer.directory, 'music');
	await mkdir(root);
	for (const [title, artist, poster] of [
		['Night Drive', 'The Satellites', 'glass-midnight-poster.png'],
		['Harbor Lights', 'Echo Garden', 'echo-garden-poster.png'],
		['Afterlight', 'The Satellites', 'afterlight-station-poster.png'],
	]) {
		await writeFile(path.join(root, `${title}.mp4`), 'documentation fixture');
		await writeFile(path.join(root, `${title}.nfo`), `<musicvideo><title>${title}</title><artist>${artist}</artist><album>Night Signals</album></musicvideo>`);
		await copyFile(path.resolve('tests/e2e/fixtures/user-documentation', poster!), path.join(root, `${title}-poster.png`));
	}
	const created = await page.request.post('/api/v1/libraries', { headers: { 'x-moirai-csrf': csrf }, data: {
		name: 'Music videos', typeKey: 'music-videos', sourceType: 'on-disk', sourceConfig: { scanRoot: root },
	} });
	expect(created.ok()).toBe(true);
	await expect.poll(async () => (await page.request.get('/api/v1/credit-templates/preview-videos')).json().then(rows => rows.length), { timeout: 30000 }).toBe(3);
	await page.goto('/playback/credit-templates');
	await capture(page, 'credit-templates.png');
	await page.getByRole('button', { name: 'View', exact: true }).click();
	const view = page.getByRole('dialog', { name: 'View Credit Template' });
	await expect(view.getByLabel('Name', { exact: true })).toBeDisabled();
	await expect(view.getByLabel('Credit template (Liquid)')).toHaveAttribute('readonly', '');
	await expect(view.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
	await expect(view.getByRole('button', { name: 'Delete Credit Template' })).toHaveCount(0);
	await capture(page, 'credit-template-view.png');
	await view.getByRole('button', { name: 'Duplicate', exact: true }).click();
	const editor = page.getByRole('dialog', { name: 'New credit template' });
	await expect(editor.getByLabel('Credit template (Liquid)')).toHaveValue(/\[Script Info\]/);
	await capture(page, 'credit-template-editor.png');
	await captureSection(page, editor.locator('.credit-preview'), 'credit-template-preview.png');
	await editor.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(editor).toBeHidden();
	await page.getByRole('button', { name: 'Edit', exact: true }).click();
	const existing = page.getByRole('dialog', { name: 'Edit credit template' });
	await expect(existing.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
	await existing.getByLabel('Name', { exact: true }).fill('Changed credits');
	await existing.getByRole('button', { name: 'Reset', exact: true }).click();
	await existing.getByRole('button', { name: 'Confirm Reset', exact: true }).click();
	await expect(existing.getByLabel('Name', { exact: true })).toHaveValue('Music video credits copy');
	await existing.getByRole('button', { name: 'Close credit template' }).click();
});

test('captures guide templates', { tag: '@docs-screenshot' }, async ({ page, documentationServer }) => {
	await seedSchedule(page, documentationServer.directory);
	await page.goto('/playback/guide-templates');
	await expect(page.getByRole('heading', { name: 'Guide Templates', exact: true })).toBeVisible();
	await capture(page, 'guide-templates.png');
	await page.getByRole('button', { name: 'View', exact: true }).click();
	const view = page.getByRole('dialog', { name: 'View Guide Template' });
	await expect(view.getByLabel('Name', { exact: true })).toBeDisabled();
	await expect(view.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
	await expect(view.getByRole('tab', { name: 'Channel', exact: true })).toBeVisible();
	await capture(page, 'guide-template-view.png');
	await view.getByRole('button', { name: 'Duplicate', exact: true }).click();
	const editor = page.getByRole('dialog', { name: 'New Guide Template' });
	await expect(editor.getByLabel('Name', { exact: true })).toBeEnabled();
	await expect(editor.locator('.guide-template-preview-frame')).toBeVisible();
	await expect(editor.locator('.guide-template-preview-overlay')).toHaveCount(0, { timeout: 30_000 });
	await capture(page, 'guide-template-editor.png');
	await editor.getByRole('button', { name: 'Close guide template' }).click();
});

test('captures encoding profiles and assigns or detaches channel settings', { tag: '@docs-screenshot' }, async ({ page }) => {
	const predictionRequests: Array<{ width: number; height: number; ffmpegPath: string | null }> = [];
	await page.route('**/api/v1/playback/hardware-acceleration/predict', async (route) => {
		predictionRequests.push(route.request().postDataJSON());
		await route.fulfill({ json: { outcome: 'none', accel: null, detail: 'Software processing on this server.' } });
	});
	const csrf = await authenticateAdministrator(page);
	await page.goto('/playback/encoding-profiles');
	await page.getByRole('button', { name: 'New Profile', exact: true }).click();
	const editor = page.getByRole('dialog', { name: 'New Encoding Profile', exact: true });
	await editor.getByLabel('Name', { exact: true }).fill('HD broadcast');
	await editor.getByLabel('Width', { exact: true }).fill('1280');
	await editor.getByLabel('Height', { exact: true }).fill('720');
	await expect(editor.locator('.acceleration-prediction')).toHaveText('None');
	expect(predictionRequests.at(-1)).toMatchObject({ width: 1280, height: 720, ffmpegPath: null });
	await capture(page, 'encoding-profile-editor.png');
	await editor.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(editor).toBeHidden();
	const profile = (await (await page.request.get('/api/v1/encoding-profiles')).json()).find((entry: { name: string }) => entry.name === 'HD broadcast');
	await page.goto('/channels');
	await page.getByRole('button', { name: 'New Channel', exact: true }).click();
	const channel = page.getByRole('dialog', { name: /(?:Edit|Create) Channel/ });
	await channel.getByLabel('Number', { exact: true }).fill('1');
	await channel.getByLabel('Name', { exact: true }).fill('Music');
	await channel.getByRole('combobox', { name: 'Audio and video settings', exact: true }).selectOption(profile.id);
	await expect(channel.locator('.encoding-disclosure-badges')).toContainText('1280 × 720');
	const encodingToggle = channel.getByRole('button', { name: /Video & audio settings/ });
	if (await encodingToggle.getAttribute('aria-expanded') === 'false') {
		await encodingToggle.click();
	}
	await expect(channel.getByLabel('Width', { exact: true })).toBeVisible();
	await expect(channel.getByLabel('Width', { exact: true })).toHaveValue('1280');
	await expect(channel.getByLabel('Width', { exact: true })).toBeDisabled();
	await channel.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(channel).toBeHidden();
	let saved = (await (await page.request.get('/api/v1/channels')).json())[0];
	expect(saved.encodingProfileId).toBe(profile.id);
	await page.goto('/playback/encoding-profiles');
	await page.getByRole('button', { name: 'Edit', exact: true }).click();
	const existing = page.getByRole('dialog', { name: 'Edit Encoding Profile', exact: true });
	await existing.getByLabel('Width', { exact: true }).fill('1920');
	await existing.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(existing).toBeHidden();
	await page.route('https://example.test/channel-logo.svg', (route) => route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="blue"/></svg>' }));
	const independent = await page.request.post('/api/v1/channels', { headers: { 'x-moirai-csrf': csrf }, data: { number: '2', name: 'Independent', logo: 'https://example.test/channel-logo.svg', video: { width: 800 } } });
	expect(independent.status()).toBe(201);
	await page.goto('/channels');
	await page.getByRole('button', { name: 'Edit Music' }).click();
	await expect(channel.getByLabel('Width', { exact: true })).toHaveValue('1920');
	await channel.getByRole('button', { name: 'Close channel editor' }).click();
	await page.getByRole('button', { name: 'Edit Independent' }).click();
	await expect(channel.getByRole('combobox', { name: 'Audio and video settings', exact: true })).toHaveValue('');
	await expect(channel.getByLabel('Width', { exact: true })).toBeVisible();
	await expect(channel.getByLabel('Width', { exact: true })).toHaveValue('800');
	await expect(channel.getByLabel('Width', { exact: true })).toBeEnabled();
	await expect(channel.getByLabel('Or use an external logo URL')).toHaveCount(0);
	await channel.getByRole('button', { name: 'Remove logo', exact: true }).click();
	await channel.getByRole('button', { name: 'Confirm remove logo', exact: true }).click();
	await channel.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(channel).toBeHidden();
	expect((await (await page.request.get('/api/v1/channels')).json()).find((entry: { name: string }) => entry.name === 'Independent').logo).toBeNull();
	await page.getByRole('button', { name: 'Edit Music' }).click();
	await channel.getByRole('combobox', { name: 'Audio and video settings', exact: true }).selectOption({ label: 'Custom' });
	await expect(channel.getByLabel('Width', { exact: true })).toHaveValue('1920');
	await expect(channel.getByLabel('Width', { exact: true })).toBeEnabled();
	await channel.getByLabel('Width', { exact: true }).fill('640');
	await channel.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(channel).toBeHidden();
	saved = (await (await page.request.get('/api/v1/channels')).json()).find((entry: { name: string }) => entry.name === 'Music');
	expect(saved).toMatchObject({ encodingProfileId: null, video: { ...profile.video, width: 640 }, audio: profile.audio });
	await page.getByRole('button', { name: 'Edit Independent' }).click();
	await channel.getByLabel('Group', { exact: true }).fill('Unsaved group');
	await channel.getByRole('link', { name: 'Manage Encoding Profiles' }).click();
	const confirmation = page.getByRole('alertdialog', { name: 'Save Changes?' });
	await expect(confirmation).toBeVisible();
	await confirmation.getByRole('button', { name: 'Discard Changes' }).click();
	await expect(page).toHaveURL(/\/playback\/encoding-profiles$/);
	const independentSaved = (await (await page.request.get('/api/v1/channels')).json()).find((entry: { name: string }) => entry.name === 'Independent');
	expect(independentSaved.group).toBeNull();
});

test('chooses built-in defaults and protects presets while allowing custom copies', { tag: '@docs-screenshot' }, async ({ page }) => {
	const predictionRequests: Array<{ width: number; height: number; ffmpegPath: string | null }> = [];
	await page.route('**/api/v1/playback/hardware-acceleration/predict', async (route) => {
		predictionRequests.push(route.request().postDataJSON());
		await route.fulfill({ json: { outcome: 'none', accel: null, detail: 'Software processing on this server.' } });
	});
	await authenticateAdministrator(page);
	await page.goto('/playback/encoding-profiles');
	const selector = page.getByRole('combobox', { name: 'Default for new channels', exact: true });
	await expect(selector.locator('option:checked')).toHaveText('1080p');
	await capture(page, 'encoding-presets.png');
	await page.setViewportSize({ width: 390, height: 844 });
	await page.reload();
	await expect(selector).toBeVisible();
	await expect(page.getByRole('button', { name: 'New Profile', exact: true })).toBeInViewport();
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
	await page.setViewportSize({ width: 1440, height: 900 });
	const preset = page.locator('article').filter({ has: page.getByRole('heading', { name: '720p', exact: true }) });
	await preset.getByRole('button', { name: 'View', exact: true }).click();
	const view = page.getByRole('dialog', { name: 'View Encoding Profile' });
	await expect(view.getByLabel('Width', { exact: true })).toBeDisabled();
	await expect(view.getByLabel('Description', { exact: true })).toBeDisabled();
	await expect(view.getByRole('button', { name: 'Delete Encoding Profile' })).toHaveCount(0);
	await expect(view.locator('.builtin-badge')).toBeVisible();
	await expect(view.locator('.acceleration-prediction')).toHaveText('None');
	expect(predictionRequests.at(-1)).toMatchObject({ width: 1280, height: 720, ffmpegPath: null });
	await capture(page, 'encoding-profile-view.png');
	await page.setViewportSize({ width: 390, height: 844 });
	expect(await view.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
	await expect(view.getByRole('button', { name: 'Duplicate', exact: true })).toBeInViewport();
	await page.setViewportSize({ width: 1440, height: 900 });
	await view.getByRole('button', { name: 'Close', exact: true }).click();
	await selector.selectOption({ label: '720p' });
	await expect(preset).toContainText('Default');
	await preset.getByRole('button', { name: 'View', exact: true }).click();
	await view.getByRole('button', { name: 'Duplicate', exact: true }).click();
	const copy = page.getByRole('dialog', { name: 'New Encoding Profile' });
	await expect(copy.getByLabel('Width', { exact: true })).toBeEnabled();
	await expect(copy.getByLabel('Description', { exact: true })).not.toHaveValue('');
	await copy.getByLabel('Name', { exact: true }).fill('My preset');
	await copy.getByLabel('Description', { exact: true }).fill('Music videos for the living room.');
	await copy.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(copy).toBeHidden();
	await page.reload();
	await expect(page.locator('article').filter({ has: page.getByRole('heading', { name: 'My preset', exact: true }) })).toContainText('Music videos for the living room.');
	await selector.selectOption({ label: 'My preset' });
	await expect(page.locator('article').filter({ has: page.getByRole('heading', { name: 'My preset', exact: true }) })).toContainText('Default');
	await page.goto('/channels');
	await page.getByRole('button', { name: 'New Channel', exact: true }).click();
	const channel = page.getByRole('dialog', { name: /(?:Edit|Create) Channel/ });
	await expect(channel.getByRole('combobox', { name: 'Audio and video settings', exact: true }).locator('option:checked')).toHaveText('My preset (default)');
	await expect(channel.getByLabel('Height', { exact: true })).toHaveValue('720');
	await expect(channel.getByRole('button', { name: 'Reset', exact: true })).toBeDisabled();
	await channel.getByRole('combobox', { name: 'Audio and video settings', exact: true }).selectOption({ label: 'Custom' });
	await expect(channel.getByLabel('Height', { exact: true })).toBeEnabled();
	await expect(channel.getByLabel('Height', { exact: true })).toHaveValue('720');
	await channel.getByRole('button', { name: 'Reset', exact: true }).click();
	await channel.getByRole('button', { name: 'Confirm Reset', exact: true }).click();
	await expect(channel.getByRole('combobox', { name: 'Audio and video settings', exact: true }).locator('option:checked')).toHaveText('My preset (default)');
});

test('protects program drafts when navigating to credit templates', async ({ page, documentationServer }) => {
	const { program } = await seedSchedule(page, documentationServer.directory);
	await page.goto(`/schedules/programs/${program.id}`);
	const editor = page.getByRole('dialog', { name: 'Edit Program', exact: true });
	const name = editor.getByRole('textbox', { name: /^Name/u });
	await editor.getByRole('button', { name: /Audio and subtitles.*optional/ }).click();
	await name.fill('Pending program name');
	await editor.getByRole('link', { name: 'Manage Credit Templates' }).click();
	const confirmation = page.getByRole('alertdialog', { name: 'Save Changes?' });
	await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
	await expect(name).toHaveValue('Pending program name');
	await expect(page).toHaveURL(new RegExp(`/schedules/programs/${program.id}$`));

	await page.route(`**/api/v1/programs/${program.id}`, async (route) => {
		if (route.request().method() === 'PATCH') {
			await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ message: 'Save temporarily unavailable' }) });
		}
		else {
			await route.continue();
		}
	});
	await editor.getByRole('link', { name: 'Manage Credit Templates' }).click();
	await confirmation.getByRole('button', { name: 'Save Changes', exact: true }).click();
	await expect(editor.getByText('Save temporarily unavailable', { exact: true })).toBeVisible();
	await expect(name).toHaveValue('Pending program name');
	await page.unroute(`**/api/v1/programs/${program.id}`);

	await editor.getByRole('link', { name: 'Manage Credit Templates' }).click();
	await confirmation.getByRole('button', { name: 'Save Changes', exact: true }).click();
	await expect(page).toHaveURL(/\/playback\/credit-templates$/u);
	const overview = await (await page.request.get('/api/v1/scheduling/overview')).json();
	expect(overview.programs.find((entry: { id: string }) => entry.id === program.id).name).toBe('Pending program name');

	await page.goto(`/schedules/programs/${program.id}`);
	await name.fill('Discarded program name');
	await editor.getByRole('link', { name: 'Manage Credit Templates' }).click();
	await confirmation.getByRole('button', { name: 'Discard Changes', exact: true }).click();
	await expect(page).toHaveURL(/\/playback\/credit-templates$/u);
	await page.goto(`/schedules/programs/${program.id}`);
	await expect(name).toHaveValue('Pending program name');
	await name.fill('Saved with editor button');
	await editor.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(page).toHaveURL(/\/schedules\/programs$/u);
});


test('animates encoding disclosure layout and respects reduced motion', async ({ page }) => {
	await authenticateAdministrator(page);
	await page.goto('/channels');
	await page.getByRole('button', { name: 'New Channel', exact: true }).click();
	const editor = page.getByRole('dialog', { name: /(?:Edit|Create) Channel/ });
	const disclosure = editor.locator('.channel-encoding-disclosure');
	const trigger = disclosure.getByRole('button', { name: /Video & audio settings/ });
	await expect(editor.getByRole('combobox', { name: 'Audio and video settings', exact: true })).toBeEnabled();
	if (await trigger.getAttribute('aria-expanded') === 'true') {
		await trigger.click();
	}
	await expect(trigger).toHaveAttribute('aria-expanded', 'false');
	await trigger.scrollIntoViewIfNeeded();
	await page.emulateMedia({ reducedMotion: 'no-preference' });
	await trigger.click();
	await expect(trigger).toHaveAttribute('aria-expanded', 'true');
	const properties = await editor.evaluate((element) => element.getAnimations({ subtree: true }).flatMap((animation) => (animation.effect as KeyframeEffect).getKeyframes().flatMap(Object.keys)));
	expect(properties).toContain('transform');
	expect(properties).not.toContain('height');
	expect(await editor.locator('.channel-guide-template-disclosure').evaluate((element) => element.getAnimations().some((animation) => (animation.effect as KeyframeEffect).getKeyframes().some((frame) => 'transform' in frame)))).toBe(true);
	await expect.poll(() => editor.evaluate((element) => element.getAnimations({ subtree: true }).length)).toBe(0);
	await trigger.click();
	await expect(disclosure.locator('.form-disclosure-content')).toHaveAttribute('inert', '');
	await expect(disclosure.locator('.form-disclosure-content')).toBeHidden();
	await expect.poll(() => editor.evaluate((element) => element.getAnimations({ subtree: true }).length)).toBe(0);

	await page.emulateMedia({ reducedMotion: 'reduce' });
	await trigger.press('Enter');
	await expect(disclosure.locator('.form-disclosure-content')).toBeVisible();
	expect(await editor.evaluate((element) => element.getAnimations({ subtree: true }).filter((animation) => (animation.effect as KeyframeEffect).getKeyframes().some((frame) => 'transform' in frame || 'height' in frame)).map((animation) => ({ duration: animation.effect?.getTiming().duration, frames: (animation.effect as KeyframeEffect).getKeyframes() })))).toEqual([]);
	await trigger.press('Enter');
	await expect(disclosure.locator('.form-disclosure-content')).toBeHidden();
	await page.emulateMedia({ reducedMotion: 'no-preference' });
	await trigger.press('Enter');
	await trigger.press('Enter');
	await expect(trigger).toHaveAttribute('aria-expanded', 'false');
	await expect(disclosure.locator('.form-disclosure-content')).toBeHidden();
	await editor.getByRole('combobox', { name: 'Audio and video settings', exact: true }).selectOption({ label: 'Custom' });
	await expect(trigger).toHaveAttribute('aria-expanded', 'true');
	await expect(editor.getByLabel('Width', { exact: true })).toBeVisible();
});


test('preserves subtitle settings across the additional-settings disclosure', async ({ page }) => {
	await authenticateAdministrator(page);
	await page.goto('/channels');
	await page.getByRole('button', { name: 'New Channel', exact: true }).click();
	const editor = page.getByRole('dialog', { name: /(?:Edit|Create) Channel/ });
	await editor.getByLabel('Number', { exact: true }).fill('12');
	await editor.getByLabel('Name', { exact: true }).fill('Subtitle layout');
	const subtitles = editor.getByRole('group', { name: 'Subtitles', exact: true });
	const trigger = subtitles.getByRole('button', { name: /Additional subtitle settings/ });
	if (await trigger.getAttribute('aria-expanded') === 'false') {
		await trigger.click();
	}
	await subtitles.getByRole('combobox', { name: 'Subtitle selection', exact: true }).selectOption('any');
	await subtitles.getByRole('textbox', { name: /^Preferred language code/ }).fill('eng');
	await subtitles.getByRole('combobox', { name: 'Music video credits', exact: true }).selectOption({ label: 'Music video credits' });
	await subtitles.getByRole('combobox', { name: 'Subtitle mode', exact: true }).selectOption('convert');
	await subtitles.getByLabel('Subtitle fonts folder', { exact: true }).fill('/fonts');
	await trigger.click();
	await expect(subtitles.getByRole('combobox', { name: 'Subtitle mode', exact: true })).toBeHidden();
	await expect(subtitles.getByRole('combobox', { name: 'Subtitle selection', exact: true })).toBeVisible();
	await expect(subtitles.getByText('Burn mode is used while credits are enabled. Your Convert setting is retained.')).toBeVisible();
	await trigger.press('Enter');
	await expect(subtitles.getByRole('combobox', { name: 'Subtitle mode', exact: true })).toHaveValue('convert');
	await trigger.press('Enter');
	await editor.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(editor).toBeHidden();
	const saved = (await (await page.request.get('/api/v1/channels')).json())[0];
	expect(saved).toMatchObject({ subtitleMode: 'convert', subtitleFontsFolder: '/fonts', subtitlePreferences: { policy: 'any', language: 'eng' } });
	expect(saved.subtitlePreferences.creditsTemplateId).toBeTruthy();
});

test('remembers channel disclosures after reopening and refreshing', async ({ page }) => {
	await authenticateAdministrator(page);
	await page.goto('/channels');
	await page.getByRole('button', { name: 'New Channel', exact: true }).click();
	const editor = page.getByRole('dialog', { name: /(?:Edit|Create) Channel/ });
	await expect(editor.getByRole('combobox', { name: 'Audio and video settings', exact: true })).toBeEnabled();
	const states = [
		{ name: /Video & audio settings/, open: false },
		{ name: /Additional subtitle settings/, open: false },
		{ name: /Channel fallback override/, open: true },
	];
	for (const state of states) {
		const trigger = editor.getByRole('button', { name: state.name });
		if (await trigger.getAttribute('aria-expanded') !== String(state.open)) {
			await trigger.click();
		}
	}
	await editor.getByRole('button', { name: 'Close channel editor' }).click();
	await expect(editor).toBeHidden();
	await page.reload();
	await page.getByRole('button', { name: 'New Channel', exact: true }).click();
	await expect(editor.getByRole('combobox', { name: 'Audio and video settings', exact: true })).toBeEnabled();
	for (const state of states) {
		await expect(editor.getByRole('button', { name: state.name })).toHaveAttribute('aria-expanded', String(state.open));
	}
	await editor.getByRole('combobox', { name: 'Audio and video settings', exact: true }).selectOption({ label: 'Custom' });
	await expect(editor.getByRole('button', { name: /Video & audio settings/ })).toHaveAttribute('aria-expanded', 'true');
});

test('refreshes incomplete credit preview metadata without losing the selection or draft', async ({ page }) => {
	await authenticateAdministrator(page);
	const first = randomUUID(), second = randomUUID();
	let scanned = false;
	let fail = false;
	await page.route('**/api/v1/credit-templates/preview-videos', route => route.fulfill(fail
		? { status: 503, json: { message: 'Catalog unavailable' } }
		: { json: [
			{ id: first, title: 'First video', durationSeconds: 180, artists: [], artworkUrl: null },
			{ id: second, title: 'Scanning video', durationSeconds: scanned ? 4 : null, artists: [], artworkUrl: null },
		] }));
	await page.goto('/playback/credit-templates');
	await page.getByRole('button', { name: 'New template', exact: true }).click();
	const editor = page.getByRole('dialog');
	await editor.getByLabel('Name', { exact: true }).fill('Unsaved preview draft');
	const source = editor.getByLabel('Credit template (Liquid)');
	await source.fill('Draft credits');
	const preview = editor.locator('.credit-preview');
	await preview.getByRole('button', { name: 'Scanning video' }).click();
	await expect(preview.getByRole('button', { name: 'Render preview' })).toBeDisabled();
	fail = true;
	await preview.getByRole('button', { name: 'Refresh videos' }).click();
	await expect(preview).toContainText('Catalog unavailable');
	fail = false;
	scanned = true;
	await preview.getByRole('button', { name: 'Retry', exact: true }).click();
	await expect(preview.getByRole('button', { name: 'Scanning video' })).toHaveAttribute('aria-pressed', 'true');
	await expect(preview.getByLabel('Source time (seconds)')).toHaveValue('2');
	await expect(preview.getByRole('button', { name: 'Render preview' })).toBeEnabled();
	await expect(preview.getByText(/scan is incomplete/)).toHaveCount(0);
	await expect(editor.getByLabel('Name', { exact: true })).toHaveValue('Unsaved preview draft');
	await expect(source).toHaveValue('Draft credits');
});

test('selects a carousel video and previews without a channel', async ({ page }) => {
	await authenticateAdministrator(page);
	const first = randomUUID(), second = randomUUID();
	await page.route('**/api/v1/credit-templates/preview-videos', route => route.fulfill({ json: [
		{ id: first, title: 'First video', durationSeconds: 180, artists: ['Artist'], artworkUrl: null },
		{ id: second, title: 'Second video', durationSeconds: 4, artists: [], artworkUrl: null },
	] }));
	let payload: Record<string, unknown> | undefined;
	let renderCount = 0;
	let finishRender!: () => void;
	const rendering = new Promise<void>(resolve => {
		finishRender = resolve;
	});
	const frameImage = (await readFile(path.resolve('tests/e2e/fixtures/user-documentation/glass-midnight-poster.png'))).toString('base64');
	await page.emulateMedia({ reducedMotion: 'no-preference' });
	await page.route('**/api/v1/credit-templates/preview', async route => {
		payload = route.request().postDataJSON();
		if (++renderCount > 1) {
			return route.fulfill({ status: 400, json: { message: 'Preview fixture failed' } });
		}
		await rendering;
		return route.fulfill({ json: { ass: '[Script Info]', image: `data:image/png;base64,${frameImage}` } });
	});
	await page.goto('/playback/credit-templates');
	await page.getByRole('button', { name: 'View', exact: true }).click();
	const preview = page.locator('.credit-preview');
	await expect(preview.getByRole('button', { name: 'First video Artist' })).toHaveAttribute('aria-pressed', 'true');
	await preview.getByRole('button', { name: 'Second video' }).click();
	await expect(preview.getByRole('button', { name: 'Second video' })).toHaveAttribute('aria-pressed', 'true');
	await expect(preview.getByRole('combobox')).toHaveCount(0);
	await preview.getByRole('button', { name: 'Render preview' }).click();
	await expect(preview.getByRole('status')).toHaveText('Rendering credit preview…');
	const frame = preview.locator('.credit-preview-frame');
	await expect(frame).toBeInViewport({ ratio: .95 });
	const loadingHeight = (await frame.boundingBox())!.height;
	finishRender();
	await expect(preview.getByAltText('Music video frame with the generated credits')).toBeVisible();
	await expect(frame).toHaveAttribute('aria-busy', 'false');
	expect((await frame.boundingBox())!.height).toBeCloseTo(loadingHeight, 0);
	expect(payload).toMatchObject({ mediaItemId: second, seconds: 2 });
	expect(payload).not.toHaveProperty('channelId');
	await page.emulateMedia({ reducedMotion: 'reduce' });
	await preview.getByRole('button', { name: 'Render preview' }).click();
	await expect(frame.getByRole('alert')).toContainText('Preview fixture failed');
	await expect(frame).toBeInViewport({ ratio: .95 });
	expect((await frame.boundingBox())!.height).toBeCloseTo(loadingHeight, 0);
});

test('compares pending guide images in place with After selected initially', async ({ page }, testInfo) => {
	await serveReviewFixture(page);
	await page.goto('/review-fixture/pending.html');
	await expect(page.locator('.review-topic')).toHaveCount(1);
	await expect(page.locator('.review-topic').getByRole('link', { name: 'Review fixture', exact: true })).toHaveAttribute('href', '/review-fixture/empty.html');
	const comparison = page.locator('.review-image');
	await expect(comparison).toHaveCount(1);
	await comparison.scrollIntoViewIfNeeded();
	const before = comparison.getByRole('button', { name: 'Before', exact: true });
	const after = comparison.getByRole('button', { name: 'After', exact: true });
	await expect(after).toHaveAttribute('aria-pressed', 'true');
	await expect(comparison.getByAltText(/^After:/)).toBeVisible();
	await expect.poll(() => comparison.locator('img').evaluateAll(images => images.every(image => (image as HTMLImageElement).naturalWidth > 0))).toBe(true);
	const originalBounds = await comparison.locator('.review-image-stage').boundingBox();
	await comparison.screenshot({ path: testInfo.outputPath('review-after.png') });
	await before.focus();
	await page.keyboard.press('Enter');
	await expect(before).toHaveAttribute('aria-pressed', 'true');
	await expect(comparison.getByAltText(/^Before:/)).toBeVisible();
	await expect(comparison.getByAltText(/^After:/)).toBeHidden();
	expect(await comparison.locator('.review-image-stage').boundingBox()).toEqual(originalBounds);
	await comparison.screenshot({ path: testInfo.outputPath('review-before.png') });
	await after.click();
	await expect(comparison.getByAltText(/^After:/)).toBeVisible();
	const textDiff = page.locator('.review-text-diff').first();
	await expect(textDiff).toContainText('-Old paragraph.');
	await expect(textDiff).toContainText('+New paragraph with <script>literal markup</script>.');
	await expect(textDiff.locator('script')).toHaveCount(0);
	await textDiff.screenshot({ path: testInfo.outputPath('review-text-diff.png') });
	await page.setViewportSize({ width: 390, height: 844 });
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('renders an empty comparison queue without image controls', async ({ page }) => {
	await serveReviewFixture(page);
	await page.goto('/review-fixture/empty.html');
	await expect(page.getByRole('heading', { level: 1, name: /^Review fixture/ })).toBeVisible();
	await expect(page.locator('.review-changes')).toBeAttached();
	await expect(page.locator('.review-topic')).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Before', exact: true })).toHaveCount(0);
	await expect(page.locator('.review-text-diff')).toHaveCount(0);
});

test('saves channel and inherited program audio preferences', async ({ page, documentationServer }) => {
	const { channel, program, requestHeaders } = await seedSchedule(page, documentationServer.directory);
	const sequenceResponse = await page.request.post('/api/v1/programs', { headers: requestHeaders, data: {
		name: 'Audio sequence', config: { type: 'sequence', repeat: true, entries: [{ id: randomUUID(), programId: program.id, count: 1 }] },
	} });
	expect(sequenceResponse.ok()).toBe(true);
	const sequence = await sequenceResponse.json() as { id: string };
	await page.goto('/channels');
	await page.getByRole('button', { name: 'Edit Moonrise Classics', exact: true }).click();
	let audio = page.getByRole('group', { name: 'Audio selection', exact: true });
	await audio.getByRole('textbox', { name: /^Preferred language code/ }).fill('EN');
	await audio.getByRole('textbox', { name: /^Preferred audio title/ }).pressSequentially('Original Surround');
	await page.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(page.getByRole('dialog', { name: /(?:Edit|Create) Channel/ })).toBeHidden();
	expect((await (await page.request.get('/api/v1/channels')).json()).find((item: { id: string }) => item.id === channel.id).audioPreferences).toEqual({ language: 'en', title: 'Original Surround' });
	await page.reload();
	await page.getByRole('button', { name: 'Edit Moonrise Classics', exact: true }).click();
	await expect(audio.getByRole('textbox', { name: /^Preferred audio title/ })).toHaveValue('Original Surround');
	await page.getByRole('button', { name: 'Close channel editor' }).click();

	for (const id of [program.id, sequence.id]) {
		await page.goto(`/schedules/programs/${id}`);
		const disclosure = page.locator('.program-subtitle-disclosure');
		const trigger = disclosure.getByRole('button', { name: /Audio and subtitles/ });
		if (await trigger.getAttribute('aria-expanded') !== 'true') {
			await trigger.click();
		}
		audio = disclosure.locator('.audio-preferences');
		const language = audio.getByRole('textbox', { name: /^Preferred language code/ });
		await expect(language).toHaveValue('');
		await language.fill('123');
		expect(await language.evaluate((input) => (input as HTMLInputElement).checkValidity())).toBe(false);
		await language.fill('*');
		await audio.getByRole('textbox', { name: /^Preferred audio title/ }).fill('Commentary');
		const save = page.getByRole('button', { name: 'Save', exact: true });
		await save.click();
		await expect(save).toBeHidden();
		await expect.poll(async () => (await (await page.request.get(`/api/v1/programs/${id}`)).json()).config.audioPreferences).toEqual({ language: null, title: 'Commentary' });
		await page.goto(`/schedules/programs/${id}`);
		await expect(audio).toBeVisible();
		await expect(language).toHaveValue('*');
		await language.fill('');
		await audio.getByRole('textbox', { name: /^Preferred audio title/ }).fill('');
		await save.click();
		await expect(save).toBeHidden();
		await expect.poll(async () => (await (await page.request.get(`/api/v1/programs/${id}`)).json()).config.audioPreferences).toEqual({});
	}
});

for (const nested of [false, true]) {
	test(`preserves ${nested ? 'nested' : 'standalone'} program drafts beneath help`, async ({ page, documentationServer }) => {
		const { program, template } = await seedSchedule(page, documentationServer.directory);
		if (nested) {
			await page.goto(`/schedules/templates/${template.id}`);
			await page.locator('.template-slot-fields').getByRole('button', { name: /^Edit / }).first().click();
		}
		else {
			await page.goto(`/schedules/programs/${program.id}`);
		}
		const editor = page.locator('.schedule-editor-modal');
		const name = editor.getByRole('textbox', { name: /^Name/ });
		await name.fill('Keep this draft');
		const help = editor.getByRole('button', { name: 'Help with Programs', exact: true });
		const originalUrl = page.url();
		let release!: () => void;
		const pending = new Promise<void>((resolve) => {
			release = resolve;
		});
		await page.route('/help/contextual-help.json', async (route) => {
			await pending;
			await route.fulfill({ status: 503 });
		});
		await help.click();
		const drawer = page.locator('.help-drawer');
		await expect(drawer).toBeFocused();
		expect(await editor.evaluate((element) => Boolean(element.closest('[inert]')))).toBe(true);
		await page.keyboard.press('Shift+Tab');
		await expect(drawer.getByRole('button', { name: 'Close help' })).toBeFocused();
		await page.keyboard.press('Tab');
		await expect(drawer.getByRole('button', { name: 'Close help' })).toBeFocused();
		await page.keyboard.press('Escape');
		release();
		await expect(drawer).toBeHidden();
		await expect(help).toBeFocused();
		await expect(name).toHaveValue('Keep this draft');
		await expect(page.getByRole('alertdialog')).toHaveCount(0);
		expect(page.url()).toBe(originalUrl);
		await help.click();
		await expect(drawer.getByRole('alert')).toContainText('Help returned 503');
		await drawer.getByRole('button', { name: 'Close help' }).click();
		await expect(help).toBeFocused();
		await page.unroute('/help/contextual-help.json');
		await help.click();
		await expect(drawer.getByRole('heading', { name: 'Programs', exact: true })).toBeVisible();
		await expect(drawer.getByRole('link', { name: 'Open full guide' })).toHaveAttribute('href', '/help/scheduling/programs.html');
		await page.locator('.help-drawer-backdrop').click({ position: { x: 2, y: 2 } });
		await expect(help).toBeFocused();
		await expect(name).toHaveValue('Keep this draft');
		await page.setViewportSize({ width: 390, height: 844 });
		await expect(help).toBeInViewport();
		expect(await editor.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
		await editor.getByRole('button', { name: 'Close program editor' }).click();
		await expect(page.getByRole('alertdialog', { name: 'Save Changes?' })).toBeVisible();
	});
}


test('opens the matching guide from each resource editor title', async ({ page, documentationServer }) => {
	const { libraryId, channel, template, requestHeaders } = await seedSchedule(page, documentationServer.directory);
	const response = await page.request.put(`/api/v1/channels/${channel.id}/schedule`, { headers: requestHeaders, data: { defaultTemplateId: template.id } });
	expect(response.ok()).toBe(true);
	const cases = [
		{ path: '/schedules/programs/new', label: 'Programs', topic: '/help/scheduling/programs.html' },
		{ path: '/schedules/templates/new', label: 'Templates', topic: '/help/scheduling/templates.html' },
		{ path: `/schedules/channels/${channel.id}`, label: 'Channel schedules', topic: '/help/scheduling/channel-schedules.html' },
		{ path: '/channels', label: 'Channels', topic: '/help/scheduling/channels.html', open: 'Edit Moonrise Classics' },
		{ path: `/libraries/${libraryId}`, label: 'Libraries', topic: '/help/libraries/managing-libraries.html', open: 'Library settings' },
		{ path: '/quick', label: 'Quick Setup', topic: '/help/getting-started/first-channel.html', open: 'Movie Channel' },
		{ path: '/playback/encoding-profiles', label: 'Encoding profiles', topic: '/help/playback/encoding-profiles.html', open: 'View' },
		{ path: '/playback/guide-templates', label: 'Guide templates', topic: '/help/playback/guide-templates.html', open: 'View' },
		{ path: '/playback/credit-templates', label: 'Credit templates', topic: '/help/playback/credit-templates.html', open: 'View' },
	];
	for (const entry of cases) {
		await page.goto(entry.path);
		if (entry.open) {
			await page.getByRole('button', { name: entry.open }).first().click();
		}
		const help = page.locator('.resource-editor-header').getByRole('button', { name: `Help with ${entry.label}`, exact: true });
		await help.click();
		const drawer = page.locator('.help-drawer');
		await expect(drawer.getByRole('link', { name: 'Open full guide' })).toHaveAttribute('href', entry.topic);
		await page.keyboard.press('Escape');
		await expect(help).toBeFocused();
	}
});

for (const kind of ['programs', 'templates'] as const) {
	test(`returns focus after the ${kind} editor finishes loading beneath help`, async ({ page, documentationServer }) => {
		const { program, template } = await seedSchedule(page, documentationServer.directory);
		let release!: () => void;
		const pending = new Promise<void>((resolve) => {
			release = resolve;
		});
		await page.route(kind === 'templates' ? '**/api/v1/schedule-templates**' : `/api/v1/${kind}`, async (route) => {
			await pending;
			await route.continue();
		});
		await page.goto(`/schedules/${kind}/${kind === 'programs' ? program.id : template.id}`);
		const header = page.locator('.resource-editor-header');
		await expect(header).toBeVisible();
		const help = header.getByRole('button', { name: /^Help with/ });
		await help.click();
		const drawer = page.locator('.help-drawer');
		await expect(drawer).toBeFocused();
		release();
		await expect(header.locator('h2')).not.toContainText('Loading');
		await expect(drawer).toBeFocused();
		await page.keyboard.press('Escape');
		await expect(help).toBeFocused();
	});
}

test('opens affected resources from dashboard identity conflicts', async ({ page, documentationServer }) => {
	const { program, template } = await seedSchedule(page, documentationServer.directory);
	const conflicts = [
		{ id: 'program', resourceType: 'program', resourceId: program.id, title: 'Program conflict' },
		{ id: 'template', resourceType: 'template', resourceId: template.id, title: 'Template conflict' },
		{ id: 'program-list', resourceType: 'program', resourceId: null, title: 'Program catalog conflict' },
		{ id: 'template-list', resourceType: 'template', resourceId: null, title: 'Template catalog conflict' },
	].map((conflict) => ({ ...conflict, kind: 'resource-name', severity: 'warning', libraryId: null, message: 'Duplicate resource name', paths: [], observedAt: null }));
	await page.route('**/api/v1/status/conflicts', (route) => route.fulfill({ json: { conflicts, truncated: false } }));

	for (const conflict of conflicts) {
		await page.goto('/');
		await page.getByRole('link', { name: new RegExp(conflict.title, 'u') }).click();
		const collection = conflict.resourceType === 'program' ? 'programs' : 'templates';
		await expect(page).toHaveURL(`${documentationServer.url}/schedules/${collection}${conflict.resourceId ? `/${conflict.resourceId}` : ''}`);
		if (conflict.resourceId) {
			await expect(page.getByRole('dialog')).toBeVisible();
		}
		else {
			await expect(page.getByRole('heading', { name: collection === 'programs' ? 'Programs' : 'Templates', exact: true })).toBeVisible();
		}
	}
});

test('shows dismissible account success while retaining credential errors', async ({ page }) => {
	await page.clock.install();
	await authenticateAdministrator(page);
	await page.goto('/account');
	for (const manualDismissal of [true, false]) {
		await page.getByLabel('Current password').fill(E2E_ADMIN_PASSWORD);
		await page.getByRole('textbox', { name: /^New password/u }).fill(E2E_ADMIN_PASSWORD);
		await page.getByLabel('Confirm new password').fill(E2E_ADMIN_PASSWORD);
		await page.getByRole('button', { name: 'Update Credentials' }).click();
		const toast = page.getByRole('status').filter({ hasText: 'Local credentials updated.' });
		await expect(toast).toBeVisible();
		if (manualDismissal) {
			await toast.getByRole('button', { name: 'Dismiss notification' }).click();
		}
		else {
			await page.clock.fastForward(5_500);
		}
		await expect(toast).toBeHidden();
	}

	await page.getByLabel('Current password').fill('an incorrect current password');
	await page.getByRole('textbox', { name: /^New password/u }).fill(E2E_ADMIN_PASSWORD);
	await page.getByLabel('Confirm new password').fill(E2E_ADMIN_PASSWORD);
	await page.getByRole('button', { name: 'Update Credentials' }).click();
	const error = page.locator('.account-panel .notice.error');
	await expect(error).toBeVisible();
	await page.clock.fastForward(5_500);
	await expect(error).toBeVisible();
	await expect(page.locator('.transient-toast')).toHaveCount(0);
});

test('keeps alphabet navigation reachable with touch targets', async ({ page, browser, documentationServer }) => {
	const { libraryId } = await seedLibrary(page, documentationServer.directory);
	const context = await browser.newContext({ baseURL: documentationServer.url, hasTouch: true, viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
	try {
		const touchPage = await context.newPage();
		await authenticateAdministrator(touchPage);
		await touchPage.goto(`/libraries/${libraryId}`);
		const alphabet = touchPage.locator('.alphabet-filter');
		for (const letter of ['W', 'A']) {
			const button = alphabet.getByRole('button', { name: letter, exact: true });
			await button.scrollIntoViewIfNeeded();
			await expect(button).toBeInViewport();
			const bounds = await button.boundingBox();
			expect(bounds!.width).toBeGreaterThanOrEqual(44);
			expect(bounds!.height).toBeGreaterThanOrEqual(44);
			await button.tap({ position: { x: 4, y: 4 } });
			await expect(touchPage.getByText(letter === 'W' ? 'Winter Archive' : 'Afterlight Station', { exact: true })).toBeInViewport();
		}
	}
	finally {
		await context.close();
	}
});

test('shows media usage on demand, including library queries, refreshes additions, and links to programs', { tag: '@docs-screenshot' }, async ({ page, documentationServer }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	const { libraryId, requestHeaders, template, channel } = await seedSchedule(page, documentationServer.directory);
	const scheduled = await page.request.put(`/api/v1/channels/${channel.id}/schedule`, { headers: requestHeaders, data: { defaultTemplateId: template.id } });
	expect(scheduled.ok(), await scheduled.text()).toBe(true);
	const response = await page.request.post('/api/v1/programs', { headers: requestHeaders, data: {
		name: 'Drama Library Query', config: { type: 'content', source: { type: 'library-query', libraryId, genres: ['drama'] }, strategy: { type: 'sequential' } },
	} });
	expect(response.ok(), await response.text()).toBe(true);
	const queryProgram = await response.json() as { id: string };
	let requests = 0;
	page.on('request', request => {
		if (request.url().includes('/resource-usage/media/')) {
			requests++;
		}
	});
	await page.goto(`/libraries/${libraryId}`);
	await page.getByRole('link', { name: /Moonrise Theater/u }).first().click();
	await expect(page.getByRole('heading', { name: 'Moonrise Theater' })).toBeVisible();
	expect(requests).toBe(0);
	const mediaId = new URL(page.url()).pathname.split('/').at(-1)!;
	await expect.poll(async () => (await (await page.request.get(`/api/v1/media/${mediaId}/airings`)).json()).total, { timeout: 30000 }).toBeGreaterThan(0);
	await capture(page, 'media-item.png');
	await page.getByRole('button', { name: 'Used by', exact: true }).click();
	const usage = page.getByRole('complementary', { name: 'Resource usage' });
	await expect(usage.getByRole('link', { name: 'Drama Library Query', exact: true })).toBeVisible();
	await expect(usage.getByRole('link', { name: 'Midnight Feature Collection', exact: true })).toBeVisible();
	const playingAt = usage.getByRole('region', { name: 'Playing at' });
	await expect(playingAt.getByRole('link', { name: /Moonrise Classics/ }).first()).toBeVisible();
	await expect(playingAt.locator('time').first()).toBeVisible();
	expect(await usage.evaluate(element => Math.abs(element.getBoundingClientRect().right - document.documentElement.clientWidth))).toBeLessThan(2);
	await capture(page, 'media-item-usage.png');
	expect(await usage.evaluate(element => element.getBoundingClientRect().top)).toBe(0);
	await page.route('**/api/v1/media/*/airings?*', route => route.fulfill({ status: 503, json: { message: 'Showings unavailable' } }));
	await playingAt.getByRole('button', { name: 'Refresh showings' }).click();
	await expect(playingAt).toContainText('Showings unavailable');
	await expect(usage.getByRole('link', { name: 'Drama Library Query', exact: true })).toBeVisible();
	await page.unroute('**/api/v1/media/*/airings?*');
	await playingAt.getByRole('button', { name: 'Retry showings' }).click();
	await expect(playingAt.locator('time').first()).toBeVisible();
	await page.getByRole('button', { name: 'Add to Program', exact: true }).click();
	const addition = page.getByRole('dialog', { name: 'Add to program', exact: true });
	await addition.getByRole('radio', { name: /Create/ }).check();
	await addition.getByRole('textbox', { name: 'Program name' }).fill('Moonrise Favorites');
	await addition.getByRole('button', { name: 'Add to Program', exact: true }).click();
	await expect(addition).toBeHidden();
	await expect(usage.getByRole('link', { name: 'Moonrise Favorites', exact: true })).toBeVisible();
	for (const width of [1024, 768]) {
		await page.setViewportSize({ width, height: 1024 });
		expect(await page.locator('.media-detail-usage > .resource-usage-main').evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
	}
	await page.setViewportSize({ width: 390, height: 844 });
	await expect(usage.getByRole('button', { name: 'Used by', exact: true })).toBeVisible();
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
	await usage.getByRole('button', { name: 'Used by', exact: true }).click();
	await expect(page.getByRole('heading', { name: 'Moonrise Theater' })).toBeVisible();
	await usage.getByRole('button', { name: 'Used by', exact: true }).click();
	await usage.getByRole('link', { name: 'Drama Library Query', exact: true }).click();
	await expect(page).toHaveURL(new RegExp(`/schedules/programs/${queryProgram.id}$`));
	await expect(page.getByRole('textbox', { name: /^Name/ })).toHaveValue('Drama Library Query');
});
