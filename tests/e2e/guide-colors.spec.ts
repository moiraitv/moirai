import { expect, test } from '@playwright/test';
import { PROGRAM_COLOR_PALETTE } from '../../apps/web/src/program-colors';
import { installGuideFixture } from './performance/guide-fixture';

for (const segmentsPerDay of [6, 48]) {
	test(`keeps guide copy white with absent, dark, and bright artwork (${segmentsPerDay} daily items)`, async ({ page }) => {
		await page.setViewportSize({ width: 1440, height: 900 });
		await installGuideFixture(page, 3);
		await page.route('**/api/v1/color-artwork/*', async (route) => {
			const fill = new URL(route.request().url()).pathname.endsWith('bright') ? '#ffffff' : '#000000';
			await route.fulfill({ contentType: 'image/svg+xml', body: `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="${fill}"/></svg>` });
		});
		await page.route('**/api/v1/schedule-guide?*', async (route) => {
			const url = new URL(route.request().url());
			const startDate = url.searchParams.get('startDate')!;
			const days = Number(url.searchParams.get('days'));
			const start = Date.parse(`${startDate}T00:00:00Z`);
			await route.fulfill({ json: {
				startDate, days, requestedDays: days, timeZone: 'UTC', segmentLimitApplied: false,
				channels: Array.from({ length: 3 }, (_, row) => {
					const channelId = `00000000-0000-4000-8000-${String(row + 1).padStart(12, '0')}`;
					const artwork = row ? `/api/v1/color-artwork/${row === 1 ? 'dark' : 'bright'}` : null;
					return { channelId, preview: {
						startDate, days, timeZone: 'UTC', issues: [], programNames: {},
						segments: Array.from({ length: days * segmentsPerDay }, (_, index) => ({
							id: `${channelId}-${index}`, channelId, programId: `program-${index}`,
							start: new Date(start + index * 86400000 / segmentsPerDay).toISOString(),
							finish: new Date(start + (index + 1) * 86400000 / segmentsPerDay).toISOString(),
							title: 'A program with a longer title', subtitle: 'Episode subtitle', role: 'primary', truncated: false,
							fanartUrl: artwork, landscapeUrl: artwork, posterUrl: artwork,
						})),
					} };
				}),
			} });
		});
		await page.goto('/guide');
		const cards = page.locator('.guide-programme');
		await expect(cards.first()).toBeAttached();
		const fanart = page.locator('.guide-programme-fanart').first();
		await expect(fanart).toBeAttached();
		await expect.poll(() => fanart.evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);

		// Read the rendered artwork treatment so a future CSS change cannot bypass contrast coverage.
		const treatment = await fanart.evaluate((image) => {
			const style = getComputedStyle(image);
			return { opacity: Number(style.opacity), filter: style.filter };
		});
		const brightness = Number(treatment.filter.match(/^brightness\(([\d.]+)\)$/)?.[1]);
		expect(Number.isFinite(brightness)).toBe(true);
		for (const color of PROGRAM_COLOR_PALETTE) {
			const solid = [1, 3, 5].map(index => Number.parseInt(color.solid.slice(index, index + 2), 16));
			const dark = [1, 3, 5].map(index => Number.parseInt(color.dark.slice(index, index + 2), 16));
			for (let step = 0; step <= 20; step += 1) {
				for (const alpha of [0, treatment.opacity / 2, treatment.opacity]) {
					const linear = solid.map((channel, index) => {
						const background = channel * (1 - step / 20) + dark[index]! * step / 20;
						const composed = (background * (1 - alpha) + 255 * brightness * alpha) / 255;
						return composed <= 0.04045 ? composed / 12.92 : ((composed + 0.055) / 1.055) ** 2.4;
					});
					const luminance = 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
					expect(1.05 / (luminance + 0.05)).toBeGreaterThanOrEqual(4.5);
				}
			}
		}
		const copy = await cards.locator('strong, small').evaluateAll(nodes => nodes.map(node => {
			const style = getComputedStyle(node);
			return { color: style.color, opacity: style.opacity };
		}));
		expect(copy.length).toBeGreaterThan(0);
		expect(copy.every(style => style.color === 'rgb(255, 255, 255)' && style.opacity === '1')).toBe(true);
		if (segmentsPerDay === 6) {
			await expect(page.locator('.guide-programme-thumb').first()).toHaveCSS('filter', 'none');
		}
		else {
			await expect(page.locator('.guide-programme-thumb')).toHaveCount(0);
		}
		const visibleCard = cards.filter({ visible: true }).first();
		await visibleCard.focus();
		await expect(visibleCard).toBeFocused();
		await expect(visibleCard).not.toHaveCSS('box-shadow', 'none');
		await page.keyboard.press('Escape');
		await page.screenshot({ path: `test-results/guide-colors-${segmentsPerDay}.png` });
	});
}
