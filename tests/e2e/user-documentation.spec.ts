import { randomUUID } from 'node:crypto';
import { rename } from 'node:fs/promises';
import { expect } from '@playwright/test';
import { SECONDS_PER_SCHEDULING_DAY } from '@moirai/shared';
import { authenticateAdministrator, E2E_ADMIN_USERNAME, E2E_ADMIN_PASSWORD } from './authentication';
import { test } from './documentation/fixture';
import { capture, captureSection, assertProgramColors } from './documentation/capture';
import { seedLibrary, seedSchedule, normalizeFixtureLogs } from './documentation/seed';
import { helpReviewLabel, type HelpReviewReason } from '../../apps/web/src/help-review';
import MarkdownIt from 'markdown-it';
import { userDocsTermBadges } from '../../scripts/user-docs-term-badges';

test('captures setup and authentication', async ({ page }) => {
	await page.goto('/setup');
	await expect(page.getByRole('heading', { name: 'Create user' })).toBeVisible();
	await capture(page, 'administrator-setup.png');

	await page.getByLabel('Username', { exact: true }).fill(E2E_ADMIN_USERNAME);
	await page.getByLabel('New password').fill(E2E_ADMIN_PASSWORD);
	await page.getByLabel('Confirm password', { exact: true }).fill(E2E_ADMIN_PASSWORD);
	await page.getByRole('button', { name: 'Create User', exact: true }).click();
	await expect(page.getByRole('heading', { name: 'Create user', exact: true })).toBeHidden();
	await page.goto('/');
	await expect(page.getByRole('heading', { name: 'Moirai overview' })).toBeVisible();
	await capture(page, 'dashboard.png');

	await page.goto('/libraries');
	await expect(page.getByText('Build your first library')).toBeVisible();
	await capture(page, 'libraries.png');

});
test('captures libraries and scanning', async ({ page, documentationServer }) => {
	const { libraryId, mediaRoot } = await seedLibrary(page, documentationServer.directory, true);
	await capture(page, 'library-catalog.png');
	await rename(mediaRoot, `${mediaRoot}-offline`);
	try {
		await page.goto(`/libraries/${libraryId}`);
		await expect(page.getByText('Media source may be offline', { exact: true })).toBeVisible();
		await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
		await expect(page.locator('.source-outage-banner')).toBeInViewport();
		await expect.poll(async () => {
			const header = await page.locator('.library-page-header').boundingBox();
			const warning = await page.locator('.source-outage-banner').boundingBox();
			return Boolean(header && warning && warning.y >= header.y + header.height
				&& warning.y + warning.height <= page.viewportSize()!.height);
		}).toBe(true);
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
	await capture(page, 'library-filters.png');
	await filters.getByRole('button', { name: 'Cancel', exact: true }).click();
	await expect(filters).toBeHidden();

	await page.getByRole('link', { name: /Moonrise Theater/u }).first().click();
	await expect(page.getByRole('heading', { name: 'Moonrise Theater' })).toBeVisible();
	await capture(page, 'media-item.png');

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
test('captures Programs', async ({ page, documentationServer }) => {
	const { libraryId, sequenceProgramIds } = await seedSchedule(page, documentationServer.directory);
	await page.goto('/schedules/programs');
	await expect(page.getByRole('heading', { name: 'Programs', exact: true })).toBeVisible();
	await capture(page, 'programs.png');
	await page.goto('/schedules/programs/new');
	await expect(page.getByRole('dialog', { name: 'Create content rule' })).toBeVisible();
	await page.getByPlaceholder('e.g. Primetime Movies').fill('Evening Cinema Selection');
	await page.getByRole('combobox', { name: 'Library', exact: true }).selectOption(libraryId);
	await expect(page.locator('.quick-query-carousel-item').first()).toBeVisible();
	await capture(page, 'program-content-create.png');

	await page.getByRole('radio', { name: /^Sequence/u }).check();
	await expect(page.getByRole('dialog', { name: 'Create sequence rule' })).toBeVisible();
	await page.getByPlaceholder('e.g. Evening Lineup').fill('Evening Cinema Sequence');
	for (const [index, programId] of sequenceProgramIds.entries()) {
		await page.getByRole('button', { name: 'Add Step', exact: true }).click();
		await page.locator('.sequence-entry select').nth(index).selectOption(programId);
		await page.locator('.sequence-entry input').nth(index).fill(index === 0 ? '2' : '1');
	}
	await expect(page.locator('.sequence-entry')).toHaveCount(3);
	await capture(page, 'program-sequence-create.png');

});
test('captures Templates', async ({ page, documentationServer }) => {
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
test('captures Channel Schedules and Guide', async ({ page, documentationServer }) => {
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
	await capture(page, 'guide.png');
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
test('captures channel settings and operations', async ({ page, documentationServer }) => {
	await seedSchedule(page, documentationServer.directory);
	await page.goto('/channels');
	await expect(page.getByRole('heading', { name: 'Channels', exact: true })).toBeVisible();
	await capture(page, 'channels.png');
	await page.goto('/settings');
	await expect(page.getByRole('heading', { name: 'IPTV service', exact: true })).toBeVisible();
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
	const broadcastEditor = page.getByRole('dialog', { name: 'Broadcast profile', exact: true });
	await expect(broadcastEditor.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('Moonrise Classics');
	await expect(broadcastEditor.locator('.fallback-filler-loading')).toBeHidden();
	await expect(broadcastEditor.locator('.acceleration-prediction')).not.toHaveText('Checking…', { timeout: 45_000 });
	await capture(page, 'channel-editor.png');
	await captureSection(page, broadcastEditor.locator('.channel-logo-editor'), 'channel-editor-logo.png');
	await captureSection(page, broadcastEditor.locator('.fallback-filler-editor'), 'channel-editor-fallback.png');
	await captureSection(page, broadcastEditor.getByRole('group', { name: 'Video normalization', exact: true }), 'channel-editor-video.png');
	await captureSection(page, broadcastEditor.getByRole('group', { name: 'Audio normalization', exact: true }), 'channel-editor-audio.png');
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
