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
		await expect.poll(() => page.evaluate(() => {
			const header = document.querySelector('.library-page-header')!.getBoundingClientRect();
			const warning = document.querySelector('.source-outage-banner')!.getBoundingClientRect();
			return { belowHeader: warning.top >= header.bottom, withinViewport: warning.bottom <= window.innerHeight };
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
	const subtitles = page.locator('.program-subtitle-disclosure');
	await subtitles.getByRole('button', { name: /Subtitles and music video credits/ }).click();
	await expect(subtitles.getByRole('combobox', { name: 'Music video credits', exact: true })).toBeEnabled();
	await captureSection(page, subtitles, 'program-subtitles.png');
	await subtitles.getByRole('button', { name: /Subtitles and music video credits/ }).click();

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
	await broadcastEditor.getByRole('button', { name: /Channel fallback override/ }).click();
	await captureSection(page, broadcastEditor.locator('.channel-fallback-disclosure'), 'channel-editor-fallback.png');
	await broadcastEditor.getByRole('combobox', { name: 'Audio and video settings', exact: true }).selectOption({ label: 'Custom' });
	await expect(broadcastEditor.getByLabel('Width', { exact: true })).toBeEnabled();
	await page.setViewportSize({ width: 1440, height: 1700 });
	await captureSection(page, broadcastEditor.locator('.channel-encoding-disclosure'), 'channel-editor-encoding.png');
	await page.setViewportSize({ width: 1440, height: 1200 });
	await captureSection(page, broadcastEditor.getByRole('group', { name: 'Video', exact: true }), 'channel-editor-video.png');
	await captureSection(page, broadcastEditor.getByRole('group', { name: 'Audio', exact: true }), 'channel-editor-audio.png');
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

test('captures music-video credit templates and verifies draft actions', async ({ page }) => {
	await authenticateAdministrator(page);
	await page.goto('/playback/credit-templates');
	await capture(page, 'credit-templates.png');
	await page.getByRole('button', { name: 'View', exact: true }).click();
	const view = page.getByRole('dialog', { name: 'View credit template' });
	await expect(view.getByLabel('Name', { exact: true })).toBeDisabled();
	await expect(view.getByLabel('Credit template (Liquid)')).toHaveAttribute('readonly', '');
	await expect(view.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
	await expect(view.getByRole('button', { name: 'Delete Credit Template' })).toHaveCount(0);
	await capture(page, 'credit-template-view.png');
	await view.getByRole('button', { name: 'Duplicate', exact: true }).click();
	const editor = page.getByRole('dialog', { name: 'New credit template' });
	await expect(editor.getByLabel('Credit template (Liquid)')).toHaveValue(/\[Script Info\]/);
	await capture(page, 'credit-template-editor.png');
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

test('captures encoding profiles and assigns or detaches channel settings', async ({ page }) => {
	const csrf = await authenticateAdministrator(page);
	await page.goto('/playback/encoding-profiles');
	await page.getByRole('button', { name: 'New profile', exact: true }).click();
	const editor = page.getByRole('dialog', { name: 'New encoding profile', exact: true });
	await editor.getByLabel('Name', { exact: true }).fill('HD broadcast');
	await editor.getByLabel('Width', { exact: true }).fill('1280');
	await editor.getByLabel('Height', { exact: true }).fill('720');
	await capture(page, 'encoding-profile-editor.png');
	await editor.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(editor).toBeHidden();
	const profile = (await (await page.request.get('/api/v1/encoding-profiles')).json()).find((entry: { name: string }) => entry.name === 'HD broadcast');
	await page.goto('/channels');
	await page.getByRole('button', { name: 'New Channel', exact: true }).click();
	const channel = page.getByRole('dialog', { name: 'Broadcast profile' });
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
	const existing = page.getByRole('dialog', { name: 'Edit encoding profile', exact: true });
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
	await channel.getByRole('link', { name: 'Manage encoding profiles' }).click();
	const confirmation = page.getByRole('alertdialog', { name: 'Save Changes?' });
	await expect(confirmation).toBeVisible();
	await confirmation.getByRole('button', { name: 'Discard Changes' }).click();
	await expect(page).toHaveURL(/\/playback\/encoding-profiles$/);
	const independentSaved = (await (await page.request.get('/api/v1/channels')).json()).find((entry: { name: string }) => entry.name === 'Independent');
	expect(independentSaved.group).toBeNull();
});

test('chooses built-in defaults and protects presets while allowing custom copies', async ({ page }) => {
	await authenticateAdministrator(page);
	await page.goto('/playback/encoding-profiles');
	const selector = page.getByRole('combobox', { name: 'Default for new channels', exact: true });
	await expect(selector.locator('option:checked')).toHaveText('1080p');
	await capture(page, 'encoding-presets.png');
	await page.setViewportSize({ width: 390, height: 844 });
	await page.reload();
	await expect(selector).toBeVisible();
	await expect(page.getByRole('button', { name: 'New profile', exact: true })).toBeInViewport();
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
	await page.setViewportSize({ width: 1440, height: 900 });
	const preset = page.locator('article').filter({ has: page.getByRole('heading', { name: '720p', exact: true }) });
	await preset.getByRole('button', { name: 'View', exact: true }).click();
	const view = page.getByRole('dialog', { name: 'View encoding profile' });
	await expect(view.getByLabel('Width', { exact: true })).toBeDisabled();
	await expect(view.getByLabel('Description', { exact: true })).toBeDisabled();
	await expect(view.getByRole('button', { name: 'Delete Encoding Profile' })).toHaveCount(0);
	await expect(view.locator('.builtin-badge')).toBeVisible();
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
	const copy = page.getByRole('dialog', { name: 'New encoding profile' });
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
	const channel = page.getByRole('dialog', { name: 'Broadcast profile' });
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
	const editor = page.getByRole('dialog', { name: 'Edit program', exact: true });
	const name = editor.getByRole('textbox', { name: /^Name/u });
	await editor.getByRole('button', { name: /Subtitles and music video credits.*Optional/ }).click();
	await name.fill('Pending program name');
	await editor.getByRole('link', { name: 'Manage credit templates' }).click();
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
	await editor.getByRole('link', { name: 'Manage credit templates' }).click();
	await confirmation.getByRole('button', { name: 'Save Changes', exact: true }).click();
	await expect(editor.getByText('Save temporarily unavailable', { exact: true })).toBeVisible();
	await expect(name).toHaveValue('Pending program name');
	await page.unroute(`**/api/v1/programs/${program.id}`);

	await editor.getByRole('link', { name: 'Manage credit templates' }).click();
	await confirmation.getByRole('button', { name: 'Save Changes', exact: true }).click();
	await expect(page).toHaveURL(/\/playback\/credit-templates$/u);
	const overview = await (await page.request.get('/api/v1/scheduling/overview')).json();
	expect(overview.programs.find((entry: { id: string }) => entry.id === program.id).name).toBe('Pending program name');

	await page.goto(`/schedules/programs/${program.id}`);
	await name.fill('Discarded program name');
	await editor.getByRole('link', { name: 'Manage credit templates' }).click();
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
	const editor = page.getByRole('dialog', { name: 'Broadcast profile' });
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
	expect(await editor.locator('.subtitle-preferences').evaluate((element) => element.getAnimations().some((animation) => (animation.effect as KeyframeEffect).getKeyframes().some((frame) => 'transform' in frame)))).toBe(true);
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
	const editor = page.getByRole('dialog', { name: 'Broadcast profile' });
	await editor.getByLabel('Number', { exact: true }).fill('12');
	await editor.getByLabel('Name', { exact: true }).fill('Subtitle layout');
	const subtitles = editor.getByRole('group', { name: 'Subtitles', exact: true });
	const trigger = subtitles.getByRole('button', { name: /Additional subtitle settings/ });
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
	const editor = page.getByRole('dialog', { name: 'Broadcast profile' });
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

test('resets credit preview pagination when switching to a smaller library', async ({ page }) => {
	await authenticateAdministrator(page);
	const large = randomUUID();
	const small = randomUUID();
	const requests: Array<{ library: string; page: number }> = [];
	await page.route('**/api/v1/libraries', (route) => route.fulfill({ json: [
		{ id: large, name: 'Large music library', typeKey: 'music-videos', enabled: true },
		{ id: small, name: 'Small music library', typeKey: 'music-videos', enabled: true },
	] }));
	await page.route('**/api/v1/channels', (route) => route.fulfill({ json: [{ id: randomUUID(), name: 'Music', number: '1' }] }));
	await page.route('**/media-source-options?*', (route) => {
		const url = new URL(route.request().url());
		const library = url.pathname.includes(small) ? small : large;
		const requestedPage = Number(url.searchParams.get('page'));
		requests.push({ library, page: requestedPage });
		return route.fulfill({ json: {
			entries: library === small && requestedPage > 1 ? [] : [{ item: { id: randomUUID(), title: library === small ? 'Small library video' : `Large library page ${requestedPage}` } }],
			pagination: { page: requestedPage, pageSize: 20, totalPages: library === small ? 1 : 2, totalItems: library === small ? 1 : 21 },
		} });
	});
	await page.goto('/playback/credit-templates');
	await page.getByRole('button', { name: 'View', exact: true }).click();
	const preview = page.locator('.credit-preview');
	await expect(preview.getByRole('combobox', { name: 'Music video', exact: true }).locator('option:checked')).toHaveText('Large library page 1');
	await preview.getByRole('button', { name: 'Next', exact: true }).click();
	await expect(preview.getByRole('combobox', { name: 'Music video', exact: true }).locator('option:checked')).toHaveText('Large library page 2');
	await preview.getByRole('combobox', { name: 'Library', exact: true }).selectOption(small);
	await expect(preview.getByRole('combobox', { name: 'Music video', exact: true }).locator('option:checked')).toHaveText('Small library video');
	await expect(preview.getByRole('button', { name: 'Render preview', exact: true })).toBeEnabled();
	expect(requests.filter((request) => request.library === small)).toEqual([{ library: small, page: 1 }]);
});
