import { expect, test } from '@playwright/test';
import { installGuideFixture } from './guide-fixture';
import { saveProfile } from './profile-output';

test.use({ trace: 'off' });

test('audits a large library page and live dashboard updates', async ({ page }, testInfo) => {
	await installGuideFixture(page, 20);
	const id = '00000000-0000-4000-8000-000000000001';
	const timestamp = new Date().toISOString();
	const library = {
		id, name: 'Synthetic Movies', typeKey: 'movies', sourceType: 'on-disk',
		sourceConfig: { scanRoot: '/synthetic', playbackRoot: null }, enabled: true, watcherEnabled: false,
		watcherStatus: 'stopped', sourceAvailability: 'available', reconciliationStatus: 'idle',
		pendingRemovalCount: 0, itemCount: 1000, warningCount: 0, lastScanStartedAt: null, lastScanCompletedAt: null,
	};
	const items = Array.from({ length: 1000 }, (_, index) => ({
		id: `${id}-${index}`, libraryId: id, kind: 'movie', title: `Movie ${index}`, sortTitle: `Movie ${index}`,
		titleBucket: 'M', year: 2026, artworkUrl: null, availability: 'available', metadataStatus: 'complete',
		durationSeconds: 5400, artists: [], parts: [], metadata: {}, createdAt: timestamp, dateAddedAt: timestamp,
	}));
	await page.route('**/api/v1/libraries', route => route.fulfill({ json: [library] }));
	await page.route(`**/api/v1/libraries/${id}`, route => route.fulfill({ json: library }));
	await page.route(`**/api/v1/libraries/${id}/reconciliation`, route => route.fulfill({ json: { status: 'idle', pendingRemovalCount: 0 } }));
	await page.route(`**/api/v1/libraries/${id}/media?*`, route => route.fulfill({ json: {
		entries: items.map(item => ({ key: item.id, kind: 'item', navigationKey: 'M', sectionKey: null, sectionLabel: null, item, group: null })),
		items, groups: [], pagination: { page: 1, pageSize: 1000, totalEntries: 1000, totalPages: 1 }, navigation: [],
	} }));
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	const session = await page.context().newCDPSession(page);
	await session.send('Performance.enable');
	const start = performance.now();
	await page.goto(`/libraries/${id}`);
	await expect(page.locator('.virtual-media-card-grid .media-card').first()).toBeVisible();
	const libraryPaint = performance.now() - start;
	const mountedCards = await page.locator('.virtual-media-card-grid .media-card').count();
	expect(mountedCards).toBeLessThan(100);
	await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
	await expect(page.getByText('Movie 999', { exact: true })).toBeVisible();
	await page.route('**/api/v1/status/conflicts', route => route.fulfill({ json: { conflicts: [] } }));
	await page.route('**/api/v1/playback/status', route => route.fulfill({ json: {
		status: 'ready', activeSessionCount: 4, maxActiveSessions: 4,
		sessions: Array.from({ length: 4 }, (_, index) => ({
			channelId: `${id}-${index}`, channelNumber: String(index), channelName: `Playing ${index}`, state: 'ready',
			startedAt: timestamp, acceleration: 'none', lastError: null,
			nowPlaying: { title: 'Synthetic programme', artworkUrl: null, startedAt: timestamp, finishesAt: new Date(Date.parse(timestamp) + 3600000).toISOString() },
			clients: [{ address: '127.0.0.1', userAgent: 'Fixture', firstSeenAt: timestamp, lastSeenAt: timestamp }],
		})),
	} }));
	await page.goto('/');
	await expect(page.locator('.playback-session-row')).toHaveCount(4);
	const before = await session.send('Performance.getMetrics');
	await page.waitForTimeout(3200);
	const after = await session.send('Performance.getMetrics');
	const dashboardTask = 1000 * ((after.metrics.find(metric => metric.name === 'TaskDuration')?.value ?? 0) - (before.metrics.find(metric => metric.name === 'TaskDuration')?.value ?? 0));
	await saveProfile(testInfo, 'library-dashboard-profile', { libraryPaint, mountedCards, dashboardTask, errors });
	console.log(JSON.stringify({ libraryPaint, mountedCards, dashboardTask, errors }));
	expect(errors).toEqual([]);
});
