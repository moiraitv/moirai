import { expect, test } from '@playwright/test';
import { installGuideFixture } from './performance/guide-fixture';

for (const [width, hours, stickyTop] of [[390, 2, 64], [1024, 4, 0], [1440, 6, 0]]) {
	test(`guide keeps navigation and time sticky with ${hours} hours at ${width}px`, async ({ page }) => {
		await page.setViewportSize({ width: width!, height: 900 });
		await installGuideFixture(page, 100);
		await page.goto('/guide');
		const frame = page.locator('.guide-frame-page');
		await expect(frame.locator('.guide-programme').first()).toBeAttached();
		await expect.poll(() => frame.evaluate(element => {
			const track = element.querySelector<HTMLElement>('.guide-scroll')!;
			const corner = element.querySelector<HTMLElement>('.guide-corner')!;
			return (track.clientWidth - corner.offsetWidth) / Number.parseFloat(element.style.getPropertyValue('--guide-hour-width'));
		})).toBeCloseTo(hours!, 1);

		await frame.evaluate(element => window.scrollTo(0, element.getBoundingClientRect().top + window.scrollY + 1200));
		const header = frame.locator('.guide-sticky-header');
		await expect.poll(async () => (await header.boundingBox())!.y).toBeCloseTo(stickyTop!, 0);
		await expect(header.getByRole('button', { name: 'Next week' })).toBeVisible();
		await expect(frame.locator('.guide-time-header')).toBeVisible();
		await expect.poll(() => frame.evaluate(element => {
			const rows = [...element.querySelectorAll<HTMLElement>('.guide-row')];
			return rows.filter(row => row.getBoundingClientRect().top >= window.innerHeight).length;
		})).toBeGreaterThanOrEqual(6);

		await frame.locator('.guide-scroll').evaluate(element => {
			element.scrollLeft += 400; 
		});
		await expect.poll(() => frame.evaluate(element => {
			return Math.abs(element.querySelector('.guide-header-scroll')!.scrollLeft - element.querySelector('.guide-scroll')!.scrollLeft);
		})).toBeLessThan(1);
		await page.screenshot({ path: `test-results/guide-layout-${width}.png` });
	});
}
