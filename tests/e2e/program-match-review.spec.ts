import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { authenticateAdministrator } from './authentication';

for (const type of ['similarity', 'theme'] as const) {
	test(`${type} reviews all matches, persists draft removals, and restores eligibility`, async ({ page }) => {
		await page.setViewportSize(type === 'theme' ? { width: 390, height: 844 } : { width: 1440, height: 1000 });
		const headers = { 'x-moirai-csrf': await authenticateAdministrator(page) };
		const libraryId = randomUUID();
		const items = Array.from({ length: 102 }, (_, index) => ({ id: randomUUID(), libraryId,
			title: `Review movie ${String(index + 1).padStart(3, '0')}`, year: 2026, artworkUrl: null, availability: 'available' }));
		const ids: string[] = [];
		let matchRequests = 0;
		const pageBaselines: Array<string[] | undefined> = [];
		try {
			await page.route('**/api/v1/libraries', route => route.fulfill({ json: [{ id: libraryId, name: 'Review library', typeKey: 'movies', sourceType: 'on-disk', sourceConfig: {} }] }));
			const sourceResponse = await page.request.post('/api/v1/programs', { headers, data: {
				name: `Review anchors ${randomUUID()}`, config: { type: 'content', source: { type: 'collection', libraryId, itemIds: [randomUUID()] }, strategy: { type: 'sequential' } },
			} });
			expect(sourceResponse.ok()).toBe(true);
			const source = await sourceResponse.json();
			ids.push(source.id);
			const response = await page.request.post('/api/v1/programs', { headers, data: {
				name: `Review ${type} ${randomUUID()}`, config: type === 'theme'
					? { type, libraryId, theme: 'Space', quantity: 1 }
					: { type, sourceProgramId: source.id, quantity: 1 },
			} });
			expect(response.ok()).toBe(true);
			const program = await response.json();
			ids.unshift(program.id);
			await page.route('**/api/v1/programs/similarity-preview', route => route.fulfill({ json: {
				programId: program.id, health: 'ready', sourceLabel: 'Review library', indexedItemCount: items.length,
				availableItemCount: items.length, matchingItemCount: items.length, requestedItemCount: 1, previewItems: items.slice(0, 1),
			} }));
			await page.route('**/api/v1/programs/semantic-matches', route => {
				matchRequests += 1;
				const body = route.request().postDataJSON();
				pageBaselines.push(body.config.excludedItemIds);
				const matches = items.filter((item) => !body.config.excludedItemIds?.includes(item.id) && !body.additionalExcludedItemIds?.includes(item.id)
					&& item.title.toLowerCase().includes(body.search.toLowerCase()));
				const offset = Number(body.cursor ?? 0);
				return route.fulfill({ json: { items: matches.slice(offset, offset + body.limit), total: matches.length,
					nextCursor: offset + body.limit < matches.length ? String(offset + body.limit) : null, pending: false, preparationFailed: false, message: 'Ready' } });
			});
			await page.route('**/api/v1/libraries/*/media-selection', route => route.fulfill({ json: items.filter((item) => route.request().postDataJSON().itemIds.includes(item.id)) }));
			await page.goto(`/schedules/programs/${program.id}`);
			await page.getByRole('button', { name: 'Review matches', exact: true }).click();
			const drawer = page.getByRole('dialog', { name: 'Review matches', exact: true });
			await expect(drawer.locator('.selected-item-preview')).toHaveCount(100);
			await expect(drawer.getByText('102 matches', { exact: true })).toBeVisible();
			await drawer.getByRole('button', { name: 'Exclude Review movie 050', exact: true }).click();
			const scrollTop = await drawer.locator('.selection-drawer-content').evaluate((element) => element.scrollTop);
			const requestsBeforeRemoval = matchRequests;
			await drawer.getByRole('button', { name: 'Confirm exclude Review movie 050', exact: true }).click();
			await expect(drawer.locator('.selected-item-preview')).toHaveCount(99);
			await expect(drawer.getByText('101 matches', { exact: true })).toBeAttached();
			await expect.poll(() => drawer.locator('.selection-drawer-content').evaluate((element) => element.scrollTop)).toBe(scrollTop);
			// Allow the previous reload debounce to elapse before checking that no request was made.
			await page.waitForTimeout(400);
			expect(matchRequests).toBe(requestsBeforeRemoval);
			await drawer.getByRole('button', { name: 'Next', exact: true }).click();
			await expect(drawer.locator('.selected-item-preview')).toHaveCount(2);
			expect(pageBaselines).toEqual([[], []]);
			await expect(drawer.getByText('Page 2', { exact: true })).toBeVisible();
			await expect(drawer.getByRole('button', { name: 'Exclude Review movie 101', exact: true })).toBeVisible();
			await expect(drawer.getByRole('button', { name: 'Exclude Review movie 102', exact: true })).toBeVisible();
			await drawer.getByRole('button', { name: 'Exclude Review movie 101', exact: true }).click();
			await drawer.getByRole('button', { name: 'Confirm exclude Review movie 101', exact: true }).click();
			await expect(drawer.locator('.selected-item-preview')).toHaveCount(1);
			await expect(drawer.getByText('Page 2', { exact: true })).toBeVisible();
			await drawer.getByRole('tab', { name: 'Removed (2)', exact: true }).click();
			await drawer.getByRole('button', { name: 'Restore Review movie 101', exact: true }).click();
			await drawer.getByRole('button', { name: 'Restore Review movie 050', exact: true }).click();
			await expect(drawer.getByText('0 removed', { exact: true })).toBeVisible();
			await drawer.getByRole('tab', { name: 'Matches', exact: true }).click();
			await drawer.getByLabel('Search selected media', { exact: true }).fill('movie 001');
			await expect(drawer.locator('.selected-item-preview')).toHaveCount(1);
			await drawer.getByRole('button', { name: 'Exclude Review movie 001', exact: true }).click();
			await drawer.getByRole('button', { name: 'Confirm exclude Review movie 001', exact: true }).click();
			await expect(drawer.getByText('0 matches', { exact: true })).toBeVisible();
			await drawer.getByRole('button', { name: 'Done', exact: true }).click();
			await page.reload();
			await page.getByRole('button', { name: 'Review matches', exact: true }).click();
			await drawer.getByRole('tab', { name: 'Removed (1)', exact: true }).click();
			await expect(drawer.getByRole('button', { name: 'Restore Review movie 001', exact: true })).toBeVisible();
			await drawer.screenshot({ path: `test-results/program-removed-${type}.png` });
			await drawer.getByRole('button', { name: 'Done', exact: true }).click();
			await page.getByRole('button', { name: 'Save', exact: true }).click();
			await expect.poll(async () => (await (await page.request.get(`/api/v1/programs/${program.id}`)).json()).config.excludedItemIds).toEqual([items[0]!.id]);
			await page.reload();
			await page.getByRole('button', { name: 'Review matches', exact: true }).click();
			await drawer.getByRole('tab', { name: 'Removed (1)', exact: true }).click();
			await drawer.getByRole('button', { name: 'Restore Review movie 001', exact: true }).click();
			await drawer.getByRole('tab', { name: 'Matches', exact: true }).click();
			await drawer.getByLabel('Search selected media', { exact: true }).fill('movie 001');
			await expect(drawer.locator('.selected-item-preview')).toHaveCount(1);
			const matchesTab = drawer.getByRole('tab', { name: 'Matches', exact: true });
			const removedTab = drawer.getByRole('tab', { name: 'Removed (0)', exact: true });
			await matchesTab.focus();
			await matchesTab.press('ArrowRight');
			await expect(removedTab).toBeFocused();
			await expect(removedTab).toHaveAttribute('aria-selected', 'true');
			await expect(matchesTab).toHaveAttribute('tabindex', '-1');
			await expect(drawer.getByRole('tabpanel', { name: 'Removed (0)', exact: true })).toBeVisible();
			await removedTab.press('Home');
			await expect(matchesTab).toBeFocused();
			await matchesTab.press('End');
			await expect(removedTab).toBeFocused();
			await removedTab.press('ArrowRight');
			await expect(matchesTab).toBeFocused();
			await matchesTab.press('ArrowLeft');
			await expect(removedTab).toBeFocused();
			await removedTab.press('Home');
			await expect(drawer.getByRole('tabpanel', { name: 'Matches', exact: true })).toBeVisible();
			await drawer.press('Escape');
			await expect(drawer).toBeHidden();
			await expect(page.getByRole('button', { name: 'Review matches', exact: true })).toBeFocused();
			await page.getByRole('button', { name: 'Save', exact: true }).click();
			await expect.poll(async () => (await (await page.request.get(`/api/v1/programs/${program.id}`)).json()).config.excludedItemIds).toEqual([]);
		}
		finally {
			for (const id of ids) {
				await page.request.delete(`/api/v1/programs/${id}`, { headers });
			}
		}
	});
}
