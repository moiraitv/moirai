import { expect, test, type Page } from '@playwright/test';
import { installGuideFixture } from './performance/guide-fixture';

test.use({ hasTouch: true });

/** Populate matching individual and grouped rows with adjacent, deliberately varied durations. */
async function installAdaptiveFixture(page: Page): Promise<void> {
	await page.clock.setFixedTime(new Date('2026-10-21T00:00:00Z'));
	await installGuideFixture(page, 2);
	await page.route('**/api/v1/schedule-guide?*', async route => {
		const url = new URL(route.request().url());
		const startDate = url.searchParams.get('startDate')!;
		const days = Number(url.searchParams.get('days'));
		const origin = Date.parse(`${startDate}T00:00:00Z`);
		const channels = [1, 2].map(row => {
			const channelId = `00000000-0000-4000-8000-${String(row).padStart(12, '0')}`;
			let elapsed = 0;
			const segments = [1, 60, 600, 1200, 3600, days * 86400 + 3600].map((seconds, index) => {
				// The first overnight listing has only one second left inside the displayed guide.
				const start = new Date(origin + (index === 0 ? -60 : elapsed) * 1000).toISOString();
				elapsed += seconds;
				return { id: `${channelId}-${index}`, channelId, programId: channelId,
					start, finish: new Date(origin + elapsed * 1000).toISOString(),
					title: `Adaptive item ${index}`, subtitle: 'Episode subtitle', role: 'primary', truncated: index === 0,
					landscapeUrl: '/api/v1/fixture-artwork', fanartUrl: '/api/v1/fixture-artwork',
				};
			});
			return { channelId, preview: { segments, issues: [], programNames: {}, startDate, days, timeZone: 'UTC' },
				...(row === 2 ? { entries: segments.map(segment => ({ ...segment, id: `block-${segment.id}`,
					kind: 'block', description: '', segmentId: null, occurrenceId: null })) } : {}),
			};
		});
		await route.fulfill({ json: { startDate, days, requestedDays: days, timeZone: 'UTC', segmentLimitApplied: false, channels } });
	});
	await page.route('**/api/v1/channels/*/guide-segments/*', async route => {
		await route.fulfill({ json: {
			segment: { title: 'Selected short item', start: '2026-10-21T00:00:01Z', finish: '2026-10-21T00:01:01Z' },
			media: null, catalogItemPresent: false,
			source: { role: 'primary', programId: null, templateId: 'fixture', programName: null, templateName: null, libraryId: null, libraryName: null },
		} });
	});
}

/** Assert painted bounds against the actual elapsed span, including the subpixel remainder of an overnight item. */
async function expectContainedCards(page: Page): Promise<void> {
	const geometry = await page.locator('.guide-channel-track').evaluateAll(tracks => tracks.map(track => {
		const cards = [...track.querySelectorAll<HTMLElement>(':scope > .guide-programme')];
		return cards.map(card => ({ left: card.getBoundingClientRect().left, right: card.getBoundingClientRect().right,
			width: card.getBoundingClientRect().width, trackRight: track.getBoundingClientRect().right, requestedWidth: Number.parseFloat(card.style.width) }));
	}));
	expect(geometry).toHaveLength(2);
	for (const row of geometry) {
		expect(row.length).toBeGreaterThanOrEqual(5);
		for (let index = 0; index < row.length; index += 1) {
			const card = row[index]!;
			// Long week-spanning cards can accumulate fractional CSS-pixel rounding.
			expect(card.width).toBeLessThanOrEqual(card.requestedWidth + 0.1);
			expect(card.right).toBeLessThanOrEqual(card.trackRight + 0.02);
			if (index > 0) {
				expect(row[index - 1]!.right).toBeLessThanOrEqual(card.left + 0.02);
			}
		}
		expect(row[0]!.width).toBeLessThan(1);
	}
}

for (const width of [390, 1440]) {
	test(`adapts Guide cards without overlap at ${width}px`, async ({ page }) => {
		await page.setViewportSize({ width, height: 900 });
		await installAdaptiveFixture(page);
		await page.goto('/guide');
		const cards = page.locator('.guide-channel-track > .guide-programme');
		await expect(cards.first()).toBeAttached();
		await expect(page.locator('.guide-listing-title').first()).toBeAttached();
		await expect(page.locator('.guide-listing-strip').first()).toBeAttached();
		await expectContainedCards(page);
		await expect(page.locator('.guide-listing-strip strong, .guide-listing-strip small, .guide-listing-strip img')).toHaveCount(0);
		await expect(page.locator('.guide-listing-title strong').first()).toBeVisible();
		await expect(page.locator('.guide-listing-title small, .guide-listing-title img')).toHaveCount(0);
		await expect(page.locator('.guide-programme-timespan').first()).toBeAttached();
		await expect(page.locator('.guide-programme-thumb').first()).toBeAttached();

		// The one-minute strip is large enough to click while still exercising the textless state.
		const strip = page.locator('button.guide-listing-strip').nth(1);
		await strip.focus();
		await expect(strip).toBeFocused();
		await strip.press('Enter');
		await expect(page.getByRole('dialog', { name: 'Selected short item' })).toBeVisible();
		await page.getByRole('button', { name: 'Close', exact: true }).click();
		await expect(page.locator('.guide-preview-modal')).toHaveCount(0);
		await strip.tap();
		await expect(page.getByRole('dialog', { name: 'Selected short item' })).toBeVisible();
		await page.getByRole('button', { name: 'Close', exact: true }).click();
		await expect(page.locator('.guide-preview-modal')).toHaveCount(0);

		const block = page.locator('.guide-block.guide-listing-strip').nth(1);
		const control = block.getByRole('button', { name: /Adaptive item 1/ });
		await control.focus();
		await expect(control).toBeFocused();
		await expect(page.getByRole('dialog', { name: 'Actual guide items' })).toBeVisible();
		await control.press('Enter');
		await expect(page.getByRole('button', { name: 'Close guide items' })).toBeVisible();
		await page.getByRole('button', { name: 'Close guide items' }).click();
		await block.hover();
		await expect(page.getByRole('dialog', { name: 'Actual guide items' })).toBeVisible();
		await page.mouse.move(0, 0);
		await page.keyboard.press('Escape');
		await expect(page.getByRole('dialog', { name: 'Actual guide items' })).toHaveCount(0);
		await page.locator('.guide-frame-page').screenshot({ path: `test-results/guide-adaptive-${width}.png` });

		await page.setViewportSize({ width: width === 390 ? 1440 : 390, height: 900 });
		await expectContainedCards(page);
		await page.locator('.guide-scroll').evaluate(element => {
			element.scrollLeft += 100;
		});
		await expect(page.locator('.guide-listing-title').first()).toBeAttached();
	});
}
