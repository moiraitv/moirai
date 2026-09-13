import { expect } from '@playwright/test';
import { test } from './documentation/fixture';
import { seedLibrary, seedSchedule } from './documentation/seed';
import { authenticateAdministrator } from './authentication';
import { capture } from './documentation/capture';
import { randomUUID } from 'node:crypto';

test('creates libraries in a protected modal with reset, error recovery, and contextual help', async ({ page, documentationServer }) => {
	await authenticateAdministrator(page);
	await page.goto('/libraries');
	await page.getByRole('button', { name: 'Add Library', exact: true }).first().click();
	const dialog = page.getByRole('dialog', { name: 'Add Library', exact: true });
	const name = dialog.getByRole('textbox', { name: 'Name', exact: true });
	await expect(name).toBeFocused();
	await capture(page, 'library-create.png');
	await page.setViewportSize({ width: 390, height: 600 });
	await expect(dialog.getByRole('button', { name: 'Add and Scan' })).toBeInViewport();
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
	await name.fill('Created library');
	await dialog.getByRole('button', { name: 'Reset', exact: true }).click();
	await dialog.getByRole('button', { name: 'Confirm Reset', exact: true }).click();
	await expect(name).toHaveValue('');
	await name.fill('Created library');
	await dialog.getByRole('button', { name: 'Close library editor' }).click();
	await page.getByRole('alertdialog').getByRole('button', { name: /Cancel/ }).click();
	await expect(page.locator('.confirmation-modal-backdrop')).toHaveCount(0);
	await expect(name).toHaveValue('Created library');
	await dialog.getByLabel('Path Moirai scans').fill(documentationServer.directory);
	await page.route('**/api/v1/libraries', route => route.request().method() === 'POST' ? route.fulfill({ status: 503, json: { message: 'Creation unavailable' } }) : route.continue());
	await dialog.getByRole('button', { name: 'Add and Scan' }).click();
	await expect(dialog).toContainText('Creation unavailable');
	await page.unroute('**/api/v1/libraries');
	await dialog.getByRole('button', { name: 'Help with Libraries' }).click();
	await expect(page.locator('.help-drawer')).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(name).toHaveValue('Created library');
	await dialog.getByRole('button', { name: 'Add and Scan' }).click();
	await expect(dialog).toBeHidden();
	await expect(page.getByRole('link', { name: 'Open library Created library' })).toBeVisible();
});

test('presents catalog introductions as styled guide content in Help', async ({ page }) => {
	await authenticateAdministrator(page);
	for (const [route, title, heading, count] of [
		['programs', 'Programs', 'What is a program?', 4],
		['templates', 'Templates', 'What is a template?', 3],
		['channels', 'Channel schedules', 'What is a channel schedule?', 3],
	] as const) {
		await page.goto(`/schedules/${route}`);
		await expect(page.getByRole('heading', { name: heading, exact: true })).toHaveCount(0);
		await page.getByRole('button', { name: `Help with ${title}` }).click();
		const intro = page.locator('.help-drawer .docs-introduction');
		await expect(intro.getByRole('heading', { name: heading, exact: true })).toBeVisible();
		await expect(intro.locator('li')).toHaveCount(count);
		await expect.poll(() => intro.locator('img').evaluateAll(images => images.every(image => (image as HTMLImageElement).naturalWidth > 0))).toBe(true);
		await page.screenshot({ path: `test-results/introduction-${route}.png`, animations: 'disabled' });
		await page.setViewportSize({ width: 390, height: 844 });
		expect(await intro.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
		await page.screenshot({ path: `test-results/introduction-${route}-mobile.png`, animations: 'disabled' });
		await page.getByRole('button', { name: 'Close help' }).click();
		await page.setViewportSize({ width: 1440, height: 900 });
		await page.goto(`/help/scheduling/${route === 'channels' ? 'channel-schedules' : route}.html`);
		const guideIntro = page.locator('.vp-doc .docs-introduction');
		await expect(guideIntro.getByRole('heading', { name: heading })).toBeVisible();
		await expect(guideIntro.locator('li')).toHaveCount(count);
		await expect(guideIntro.locator('ul')).toHaveCSS('display', 'grid');
		await page.screenshot({ path: `test-results/introduction-${route}-guide.png`, animations: 'disabled' });
	}
});

test('loads direct references only on demand, retries, and guards navigation between programs', async ({ page, documentationServer }) => {
	const { program } = await seedSchedule(page, documentationServer.directory);
	const csrf = await authenticateAdministrator(page);
	const response = await page.request.post('/api/v1/programs', { headers: { 'x-moirai-csrf': csrf }, data: { name: 'Owner sequence', config: { type: 'sequence', entries: [{ id: randomUUID(), programId: program.id, count: 1 }] } } });
	expect(response.ok(), await response.text()).toBe(true);
	const owner = await response.json();
	let requests = 0;
	let fail = true;
	await page.route('**/api/v1/resource-usage/**', route => {
		requests++;
		return fail ? route.fulfill({ status: 503, json: { message: 'Usage unavailable' } }) : route.continue();
	});
	await page.goto(`/schedules/programs/${program.id}`);
	const dialog = page.getByRole('dialog').last();
	await expect(dialog.getByRole('textbox', { name: /^Name/ })).toBeVisible();
	expect(requests).toBe(0);
	await dialog.getByRole('button', { name: 'Used by', exact: true }).click();
	await expect(dialog.locator('.resource-usage')).toContainText('Usage unavailable');
	fail = false;
	await dialog.locator('.resource-usage').getByRole('button', { name: 'Retry' }).click();
	await expect(dialog.locator('.resource-usage')).toContainText('Owner sequence');
	await page.setViewportSize({ width: 390, height: 600 });
	await expect(dialog.getByRole('link', { name: 'Owner sequence' })).toBeVisible();
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
	await page.screenshot({ path: 'test-results/batch4-usage-mobile.png' });
	await page.setViewportSize({ width: 1440, height: 900 });
	await dialog.getByRole('textbox', { name: /^Name/ }).fill('Unsaved program');
	await dialog.getByRole('link', { name: 'Owner sequence' }).click();
	await page.getByRole('alertdialog').getByRole('button', { name: /Cancel/ }).click();
	await expect(page.locator('.confirmation-modal-backdrop')).toHaveCount(0);
	await expect(dialog.getByRole('textbox', { name: /^Name/ })).toHaveValue('Unsaved program');
	await dialog.getByRole('link', { name: 'Owner sequence' }).click();
	await page.getByRole('alertdialog').getByRole('button', { name: /Discard/ }).click();
	await expect(page).toHaveURL(new RegExp(owner.id));
	await expect(dialog.getByRole('textbox', { name: /^Name/ })).toHaveValue('Owner sequence');
});

test('opens linked channels directly and rejects invalid usage requests', async ({ page }) => {
	const csrf = await authenticateAdministrator(page);
	const profiles = await (await page.request.get('/api/v1/encoding-profiles')).json();
	const profile = profiles.find((entry: { isDefault: boolean }) => entry.isDefault);
	const response = await page.request.post('/api/v1/channels', { headers: { 'x-moirai-csrf': csrf }, data: { number: '1', name: 'Linked channel', encodingProfileId: profile.id } });
	expect(response.ok()).toBe(true);
	const channel = await response.json();
	await page.goto('/playback/encoding-profiles');
	await page.getByRole('button', { name: 'View', exact: true }).first().click();
	await page.getByRole('button', { name: 'Used by', exact: true }).click();
	await page.getByRole('link', { name: 'Linked channel' }).click();
	await expect(page).toHaveURL(new RegExp(`edit=${channel.id}`));
	await expect(page.getByRole('dialog', { name: 'Edit Channel' }).getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('Linked channel');
	await page.getByRole('button', { name: 'Close channel editor' }).click();
	await expect(page).toHaveURL(/\/channels$/);
	await page.goto(`/channels?edit=${randomUUID()}`);
	await expect(page.getByText('Channel not found. It may have been deleted.')).toBeVisible();
	expect((await page.request.get(`/api/v1/resource-usage/program/${randomUUID()}`)).status()).toBe(404);
	expect((await page.request.get(`/api/v1/resource-usage/encoding-profile/${profile.id}?pageSize=101`)).status()).toBe(400);
	await page.context().clearCookies();
	expect((await page.request.get(`/api/v1/resource-usage/encoding-profile/${profile.id}`)).status()).toBe(401);
});

for (const dirtyOwner of ['template', 'channel schedule'] as const) {
	test(`protects the dirty ${dirtyOwner} when nested usage links change channel schedules`, async ({ page, documentationServer }) => {
		const { program, template, channel, requestHeaders } = await seedSchedule(page, documentationServer.directory);
		const response = await page.request.post('/api/v1/channels', { headers: requestHeaders, data: { number: '8', name: 'Other channel' } });
		expect(response.ok()).toBe(true);
		const other = await response.json();
		for (const id of [channel.id, other.id]) {
			const saved = await page.request.put(`/api/v1/channels/${id}/schedule`, {
				headers: requestHeaders,
				data: { defaultTemplateId: template.id, defaultFiller: { programId: program.id, policy: 'best-fit-or-truncate' } },
			});
			expect(saved.ok(), await saved.text()).toBe(true);
		}
		await page.goto(`/schedules/channels/${channel.id}`);
		const schedule = page.getByRole('dialog', { name: 'Channel schedule editor', exact: true });
		let editor;
		if (dirtyOwner === 'template') {
			await schedule.getByRole('button', { name: 'Edit Evening Cinema Day', exact: true }).click();
			editor = page.getByRole('dialog', { name: 'Template editor', exact: true });
			await editor.getByRole('textbox', { name: 'Template name', exact: true }).fill('Unsaved template');
		}
		else {
			await schedule.getByRole('combobox', { name: 'Selection policy', exact: true }).selectOption('next-fit-only');
			await schedule.getByRole('button', { name: 'Edit Midnight Feature Collection', exact: true }).click();
			editor = page.locator('.schedule-editor-modal');
		}
		await editor.getByRole('button', { name: 'Used by', exact: true }).click();
		await editor.getByRole('link', { name: 'Other channel', exact: true }).click();
		const confirmation = page.getByRole('alertdialog');
		await expect(confirmation).toContainText(`Leave this ${dirtyOwner} without saving`);
		await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
		await expect(page.locator('.confirmation-modal-backdrop')).toHaveCount(0);
		await expect(page).toHaveURL(new RegExp(`/schedules/channels/${channel.id}$`));
		if (dirtyOwner === 'template') {
			await expect(editor.getByRole('textbox', { name: 'Template name', exact: true })).toHaveValue('Unsaved template');
		}
		else {
			await expect(schedule.getByRole('combobox', { name: 'Selection policy', exact: true })).toHaveValue('next-fit-only');
		}
		await editor.getByRole('link', { name: 'Other channel', exact: true }).click();
		await confirmation.getByRole('button', { name: 'Discard Changes', exact: true }).click();
		await expect(page).toHaveURL(new RegExp(`/schedules/channels/${other.id}$`));
		await expect(editor).toHaveCount(0);
		await expect(schedule.getByRole('heading', { name: 'Other channel', exact: true })).toBeVisible();
		const policy = schedule.getByRole('combobox', { name: 'Selection policy', exact: true });
		await expect(policy).toHaveValue('best-fit-or-truncate');
		await policy.selectOption('next-fit-only');
		await expect(schedule.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
	});
}

test('dismisses the nested program after accepted usage navigation between templates', async ({ page, documentationServer }) => {
	const { template, requestHeaders } = await seedSchedule(page, documentationServer.directory);
	const original = await (await page.request.get('/api/v1/schedule-templates')).json();
	const source = original.find((entry: { id: string }) => entry.id === template.id);
	const slotId = randomUUID();
	const response = await page.request.post('/api/v1/schedule-templates', { headers: requestHeaders, data: {
		name: 'Destination template',
		slots: [{ id: slotId, startSeconds: 0, programId: source.slots[0].programId }],
		boundaries: [{ ...source.boundaries[0], id: randomUUID(), leftSlotId: slotId, rightSlotId: slotId }],
	} });
	expect(response.ok(), await response.text()).toBe(true);
	const destination = await response.json();
	await page.goto(`/schedules/templates/${template.id}`);
	await page.locator('.template-slot-fields').getByRole('button', { name: /^Edit / }).first().click();
	const program = page.locator('.schedule-editor-modal');
	await program.getByRole('textbox', { name: /^Name/ }).fill('Unsaved nested program');
	await program.getByRole('button', { name: 'Used by', exact: true }).click();
	await program.getByRole('link', { name: 'Destination template', exact: true }).click();
	const confirmation = page.getByRole('alertdialog');
	await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
	await expect(page.locator('.confirmation-modal-backdrop')).toHaveCount(0);
	await expect(page).toHaveURL(new RegExp(`/schedules/templates/${template.id}$`));
	await expect(program.getByRole('textbox', { name: /^Name/ })).toHaveValue('Unsaved nested program');
	await program.getByRole('link', { name: 'Destination template', exact: true }).click();
	await confirmation.getByRole('button', { name: /Discard/ }).click();
	await expect(page).toHaveURL(new RegExp(`/schedules/templates/${destination.id}$`));
	await expect(program).toHaveCount(0);
	const editor = page.getByRole('dialog', { name: 'Template editor', exact: true });
	await expect(editor.getByRole('textbox', { name: 'Template name', exact: true })).toHaveValue('Destination template');
	await editor.getByRole('textbox', { name: 'Template name', exact: true }).fill('Editable destination');
	await expect(editor.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
});

for (const nested of [false, true]) {
	test(`keeps ${nested ? 'nested' : 'standalone'} program controls in the wide column beside the type rail`, async ({ page, documentationServer }) => {
		const { program, template } = await seedSchedule(page, documentationServer.directory);
		await page.goto(nested ? `/schedules/templates/${template.id}` : `/schedules/programs/${program.id}`);
		if (nested) {
			await page.locator('.template-slot-fields').getByRole('button', { name: /^Edit / }).first().click();
		}
		const editor = page.locator('.schedule-editor-modal');
		await expect(editor.getByRole('textbox', { name: /^Name/ })).toBeVisible();
		for (const expanded of [false, true]) {
			if (expanded) {
				const control = (await editor.locator('.resource-usage').boundingBox())!;
				await page.mouse.click(control.x + control.width - 3, control.y + 3);
				await expect(editor.getByRole('button', { name: 'Used by', exact: true })).toHaveAttribute('aria-expanded', 'true');
				await expect(editor.locator('.resource-usage')).toContainText('Evening Cinema Day');
			}
			await expect.poll(() => editor.evaluate(element => element.getAnimations({ subtree: true }).filter(animation => animation.playState === 'running').length)).toBe(0);
			const rail = (await editor.locator('.program-editor-rail').boundingBox())!;
			const main = (await editor.locator('.program-editor-main').boundingBox())!;
			const usage = (await editor.locator('.resource-usage').boundingBox())!;
			expect(main.x).toBeGreaterThanOrEqual(rail.x + rail.width - 1);
			expect(Math.abs(main.y - rail.y)).toBeLessThan(1);
			expect(main.width).toBeGreaterThan(rail.width * 2);
			if (expanded) {
				expect(usage.x).toBeGreaterThanOrEqual(main.x + main.width - 1);
			}
			else {
				const content = (await editor.locator('.resource-usage-layout').boundingBox())!;
				expect(Math.abs(main.x + main.width - content.x - content.width)).toBeLessThan(1);
				await page.screenshot({ path: `test-results/program-layout-closed-${nested ? 'nested' : 'standalone'}.png` });
			}
			expect(usage.width).toBeLessThan(main.width);
		}
		await page.screenshot({ path: `test-results/program-layout-${nested ? 'nested' : 'standalone'}.png` });
		await page.setViewportSize({ width: 390, height: 600 });
		await expect(editor.getByRole('textbox', { name: /^Name/ })).toBeHidden();
		await editor.getByRole('button', { name: 'Used by', exact: true }).click();
		await expect(editor.getByRole('textbox', { name: /^Name/ })).toBeVisible();
		const mobileRail = (await editor.locator('.program-editor-rail').boundingBox())!;
		const mobileMain = (await editor.locator('.program-editor-main').boundingBox())!;
		expect(mobileMain.y).toBeGreaterThanOrEqual(mobileRail.y + mobileRail.height - 1);
		expect(Math.abs(mobileMain.width - mobileRail.width)).toBeLessThan(1);
		expect(await editor.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
		await page.setViewportSize({ width: 1440, height: 900 });
		await page.emulateMedia({ reducedMotion: 'no-preference' });
		const motion = await editor.evaluate(async element => {
			const content = element.querySelector('.program-editor-main')!;
			const before = content.getBoundingClientRect().width;
			(element.querySelector('.resource-usage-toggle') as HTMLButtonElement).click();
			await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
			const animations = element.getAnimations({ subtree: true }).filter(animation => {
				const target = (animation.effect as KeyframeEffect).target;
				return target instanceof Element && target.matches('.resource-usage-layout, .resource-usage');
			});
			for (const animation of animations) {
				animation.pause();
				animation.currentTime = 175;
			}
			const midpoint = content.getBoundingClientRect().width;
			const scales = animations.map(animation => {
				const target = (animation.effect as KeyframeEffect).target as HTMLElement;
				const transform = new DOMMatrixReadOnly(getComputedStyle(target).transform);
				return [transform.a, transform.d];
			});
			for (const animation of animations) {
				animation.finish();
			}
			return { before, midpoint, after: content.getBoundingClientRect().width, scales };
		});
		expect(motion.midpoint).toBeLessThan(motion.before);
		expect(motion.midpoint).toBeGreaterThan(motion.after);
		for (const scale of motion.scales) {
			expect(scale).toEqual([1, 1]);
		}
	});
}

test('keeps template start time within its tablet row', async ({ page, documentationServer }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	const { template } = await seedSchedule(page, documentationServer.directory);
	await page.goto(`/schedules/templates/${template.id}`);
	const fields = page.locator('.template-slot-fields');
	await expect(fields).toBeVisible();
	await page.getByRole('button', { name: 'Add Slot', exact: true }).click();
	await page.locator('.template-timeline').press('Enter');
	await expect(fields.locator('input[type="time"]')).toBeEnabled();
	for (const width of [768, 1024]) {
		await page.setViewportSize({ width, height: 1024 });
		for (const expanded of [false, true]) {
			const toggle = page.getByRole('button', { name: 'Used by', exact: true });
			if (await toggle.getAttribute('aria-expanded') !== String(expanded)) {
				await toggle.click();
			}
			const time = fields.locator('input[type="time"]');
			await time.scrollIntoViewIfNeeded();
			await page.screenshot({ path: `test-results/template-time-${width}-${expanded}.png` });
			const timeBox = (await time.boundingBox())!;
			const labelBox = (await time.locator('xpath=ancestor::label').boundingBox())!;
			const programBox = (await fields.locator('select').boundingBox())!;
			expect(timeBox.width).toBeLessThanOrEqual(labelBox.width);
			expect(Math.abs(timeBox.height - programBox.height)).toBeLessThanOrEqual(1);
		}
	}
});

test('keeps primary navigation visible while scrolling a long page', async ({ page }) => {
	await authenticateAdministrator(page);
	await page.setViewportSize({ width: 1024, height: 768 });
	await page.goto('/settings');
	await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
	await expect(page.locator('.sidebar')).toBeVisible();
	await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
	await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(100);
	await expect.poll(async () => (await page.locator('.sidebar').boundingBox())!.y).toBe(0);
	await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeInViewport();
	await page.screenshot({ path: 'test-results/sidebar-scrolled-tablet.png', animations: 'disabled' });
});

test('fits channel schedule time ranges within tablet condition rows', async ({ page, documentationServer }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	const { channel, template } = await seedSchedule(page, documentationServer.directory);
	await page.goto(`/schedules/channels/${channel.id}`);
	const editor = page.getByRole('dialog', { name: 'Channel schedule editor' });
	await editor.getByRole('button', { name: 'Add Conditional Template' }).click();
	await editor.getByRole('combobox', { name: 'Conditional layer template' }).selectOption(template.id);
	await editor.getByRole('combobox', { name: 'Predicate type' }).last().selectOption('time-range');
	const starts = editor.getByLabel('Starts', { exact: true });
	const ends = editor.getByLabel('Ends', { exact: true });
	await starts.fill('12:00');
	await ends.fill('17:00');
	await ends.blur();
	for (const width of [1024, 768, 390]) {
		await page.setViewportSize({ width, height: 1024 });
		await starts.scrollIntoViewIfNeeded();
		for (const field of [starts, ends]) {
			const bounds = (await field.boundingBox())!;
			const label = (await field.locator('..').boundingBox())!;
			expect(bounds.width).toBeLessThanOrEqual(label.width);
			expect(bounds.height).toBe(42);
		}
		await page.screenshot({ path: `test-results/schedule-time-range-${width}.png`, animations: 'disabled' });
	}
	await expect(starts).toHaveValue('12:00');
	await expect(ends).toHaveValue('17:00');
});

test('fits library date filters within tablet and phone fields', async ({ page, documentationServer }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await seedLibrary(page, documentationServer.directory);
	await page.getByRole('button', { name: 'Filter media', exact: true }).click();
	const filters = page.getByRole('dialog', { name: 'Filter media' });
	const dates = filters.getByRole('group', { name: 'Added', exact: true }).locator('input[type="date"]');
	for (const populated of [false, true]) {
		if (populated) {
			await dates.nth(0).fill('2026-01-01');
			await dates.nth(1).fill('2026-01-31');
			await dates.nth(1).blur();
		}
		for (const width of [1024, 768, 390]) {
			await page.setViewportSize({ width, height: 1024 });
			await dates.first().scrollIntoViewIfNeeded();
			for (const date of await dates.all()) {
				const bounds = (await date.boundingBox())!;
				const parent = (await date.locator('..').boundingBox())!;
				expect(bounds.width).toBeLessThanOrEqual(parent.width);
				expect(bounds.height).toBe(42);
			}
			await page.screenshot({ path: `test-results/library-date-${width}-${populated}.png`, animations: 'disabled' });
		}
	}
	await expect(dates.nth(0)).toHaveValue('2026-01-01');
	await expect(dates.nth(1)).toHaveValue('2026-01-31');
});

for (const cached of [false, true]) {
	test(`refreshes ${cached ? 'stale' : 'missing'} cached channels before opening usage links`, async ({ page }) => {
		const csrf = await authenticateAdministrator(page);
		const profiles = await (await page.request.get('/api/v1/encoding-profiles')).json();
		const profile = profiles.find((entry: { isDefault: boolean }) => entry.isDefault);
		const response = await page.request.post('/api/v1/channels', {
			headers: { 'x-moirai-csrf': csrf },
			data: { number: '1', name: 'Current channel', encodingProfileId: profile.id },
		});
		expect(response.ok()).toBe(true);
		const channel = await response.json();
		let refreshing = false;
		let requestedRefresh = false;
		let releaseRefresh!: () => void;
		const refreshGate = new Promise<void>(resolve => {
			releaseRefresh = resolve;
		});
		await page.route('**/api/v1/channels', async route => {
			if (refreshing) {
				requestedRefresh = true;
				await refreshGate;
			}
			await route.fulfill({ json: refreshing ? [channel] : cached ? [{ ...channel, name: 'Cached channel' }] : [] });
		});
		await page.goto('/channels');
		await expect(cached
			? page.getByRole('button', { name: 'Edit Cached channel', exact: true })
			: page.getByRole('heading', { name: 'No channels configured', exact: true })).toBeVisible();
		await page.locator('.primary-nav a[href="/playback/encoding-profiles"]').click();
		await page.getByRole('button', { name: 'View', exact: true }).first().click();
		await page.getByRole('button', { name: 'Used by', exact: true }).click();
		refreshing = true;
		try {
			await page.getByRole('link', { name: 'Current channel', exact: true }).click();
			await expect.poll(() => requestedRefresh).toBe(true);
			await expect(page.getByRole('dialog', { name: 'Edit Channel' })).toHaveCount(0);
			await expect(page.getByText('Channel not found. It may have been deleted.')).toHaveCount(0);
		}
		finally {
			releaseRefresh();
		}
		await expect(page.getByRole('dialog', { name: 'Edit Channel' }).getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('Current channel');
	});
}

test('expands additional stars inline and remembers the disclosure across media reloads', async ({ page, documentationServer }) => {
	const { libraryId, mediaIds } = await seedLibrary(page, documentationServer.directory);
	const mediaId = mediaIds[0]!;
	await page.route(`**/api/v1/media/${mediaId}`, async route => {
		const response = await route.fetch();
		await route.fulfill({ response, json: { ...await response.json(), actors: [...Array.from({ length: 7 }, (_, index) => ({ name: `Cast Member ${index + 1}`, role: `Character ${index + 1}`, sortOrder: index })), ...Array.from({ length: 6 }, (_, index) => ({ name: `Documentary Person ${index + 1}`, role: ['Self', 'Host', 'Narrator'][index % 3], sortOrder: index + 7 })), { name: 'Pat Producer', role: 'Executive Producer', sortOrder: 20 }] } });
	});
	await page.goto(`/libraries/${libraryId}/items/${mediaId}`);
	const otherCredits = page.getByRole('region', { name: 'Crew and production' });
	await expect(otherCredits).toContainText('Sam Rivera');
	await expect(otherCredits).not.toContainText('Cast Member');
	await expect(otherCredits).toContainText('Pat Producer (Executive Producer)');
	const stars = page.locator('.detail-stars');
	const appearances = page.locator('.detail-other-appearances');
	await expect(stars).not.toContainText('Documentary Person');
	await expect(stars).not.toContainText('Pat Producer');
	await expect(appearances).not.toContainText('Cast Member');
	await expect(appearances).toContainText('Documentary Person 1 (Self)');
	const appearanceDisclosure = appearances.locator('.detail-cast-disclosure');
	await appearanceDisclosure.getByRole('button', { name: 'More', exact: true }).click();
	await expect(appearanceDisclosure.locator('.animated-disclosure-content')).toBeVisible();
	const disclosure = stars.locator('.detail-cast-disclosure');
	await expect(disclosure.getByRole('button', { name: 'More', exact: true })).toHaveAttribute('aria-expanded', 'false');
	await expect(disclosure.locator('.animated-disclosure-content')).toBeHidden();
	await disclosure.getByRole('button', { name: 'More', exact: true }).click();
	await expect(disclosure.locator('.animated-disclosure-content')).toBeVisible();
	await expect(disclosure.locator('.animated-disclosure-content')).toContainText('Cast Member 7 (Character 7)');
	await page.reload();
	await expect(appearanceDisclosure.getByRole('button', { name: 'Less', exact: true })).toHaveAttribute('aria-expanded', 'true');
	await expect(disclosure.getByRole('button', { name: 'Less', exact: true })).toHaveAttribute('aria-expanded', 'true');
	await disclosure.getByRole('button', { name: 'Less', exact: true }).click();
	await expect(disclosure.locator('.animated-disclosure-content')).toBeHidden();
});
