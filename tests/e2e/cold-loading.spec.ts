import { expect, test } from '@playwright/test';
import { catalogProgramItemFilterSchema, DEFAULT_MAX_EXPLICIT_MEDIA_ITEMS, LIVE_EVENT_PROTOCOL_VERSION } from '@moirai/shared';
import { librarySchema } from '@moirai/shared/api-contracts';
import { installGuideFixture } from './performance/guide-fixture';

const libraryId = '00000000-0000-4000-8000-000000000020';
const programId = '00000000-0000-4000-8000-000000000021';
const otherProgramId = '00000000-0000-4000-8000-000000000022';
const now = '2026-09-20T00:00:00Z';
const library = librarySchema.parse({
	id: libraryId, name: 'Movies', typeKey: 'movies', sourceType: 'on-disk',
	sourceConfig: { scanRoot: '/media', playbackRoot: null },
	watcherStatus: 'stopped', sourceAvailability: 'available', sourceAvailabilityUpdatedAt: now,
	reconciliationStatus: 'idle', pendingRemovalCount: 0, lastScanStartedAt: null,
	lastScanCompletedAt: null, lastChangeDetectedAt: null, lastIndexedChangeAt: null,
	itemCount: 0, warningCount: 0,
	createdAt: now, updatedAt: now,
});
const program = {
	id: programId, name: 'Feature Films', createdAt: now, updatedAt: now,
	config: {
		type: 'content', strategy: { type: 'sequential' },
		source: { type: 'library-query', libraryId, kinds: ['movie'], ...catalogProgramItemFilterSchema.parse({}) },
	},
};

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>(complete => {
		resolve = complete;
	});
	return { promise, resolve };
}

for (const path of ['/channels', '/guide']) {
	test(`shows the first committed day on ${path} while the full window is pending`, async ({ page }) => {
		await installGuideFixture(page, 1, 24, false, false, 3);
		const first = deferred();
		const full = deferred();
		const configuration = deferred();
		const capabilities = deferred();
		let fullOverviewReads = 0;
		let capabilityReads = 0;
		let guideReads = 0;
		await page.route('**/api/v1/capabilities', async route => {
			capabilityReads += 1;
			await capabilities.promise;
			await route.fallback();
		});
		await page.route(/\/api\/v1\/scheduling\/overview$/, async route => {
			fullOverviewReads += 1;
			await full.promise;
			await route.fallback();
		});
		await page.route('**/api/v1/scheduling/overview?includeProgramStatuses=false', async route => {
			await configuration.promise;
			await route.fallback();
		});
		await page.route('**/api/v1/schedule-guide?*', async route => {
			guideReads += 1;
			await (new URL(route.request().url()).searchParams.get('days') === '1' ? first.promise : full.promise);
			await route.fallback();
		});
		try {
			await page.goto(path);
			if (path === '/channels') {
				await expect(page.getByRole('heading', { name: 'Synthetic 1', exact: true })).toBeVisible();
				await expect(page.getByRole('button', { name: 'Edit Synthetic 1', exact: true })).toBeEnabled();
				await expect(page.getByText('Loading schedule…', { exact: true })).toBeVisible();
				await expect(page.getByText('Loading guide…', { exact: true })).toBeVisible();
			}
			await expect.poll(() => capabilityReads).toBe(1);
			expect(guideReads).toBe(0);
			capabilities.resolve();
			first.resolve();
			await expect(page.locator('.guide-programme').first()).toBeVisible();
			expect(fullOverviewReads).toBe(0);
		}
		finally {
			first.resolve();
			full.resolve();
			configuration.resolve();
			capabilities.resolve();
		}
	});
}

test('positions Channels at the current time when capabilities arrive after channel rows', async ({ page }) => {
	await page.clock.setFixedTime(new Date('2026-09-20T20:00:00Z'));
	await installGuideFixture(page, 1, 24);
	const capabilities = deferred();
	const timeZone = 'America/Los_Angeles';
	await page.route('**/api/v1/capabilities', async route => {
		await capabilities.promise;
		await route.fulfill({ json: { timeZone, publicUrl: 'http://localhost', publicUrlStatus: 'configured',
			maxExplicitMediaItems: DEFAULT_MAX_EXPLICIT_MEDIA_ITEMS } });
	});
	try {
		await page.goto('/channels');
		await expect(page.getByRole('button', { name: 'Edit Synthetic 1' })).toBeVisible();
		capabilities.resolve();
		await expect(page.getByText(timeZone, { exact: true })).toBeVisible();
		await expect(page.locator('.guide-programme').first()).toBeVisible();
		await expect(page.locator('.guide-header-scroll .current-time-line')).toBeInViewport();
	}
	finally {
		capabilities.resolve();
	}
});

test('uses the server calendar date when a reconnect supersedes the initial capabilities read', async ({ page }) => {
	await page.clock.setFixedTime(new Date('2026-09-20T02:00:00Z'));
	await installGuideFixture(page, 1, 24);
	const initial = deferred();
	let reads = 0;
	let sendReady: (() => void) | undefined;
	await page.routeWebSocket('**/api/v1/events', socket => {
		sendReady = () => socket.send(JSON.stringify({ type: 'system.ready', protocolVersion: LIVE_EVENT_PROTOCOL_VERSION,
			eventId: libraryId, occurredAt: now, data: { connectionId: libraryId } }));
	});
	await page.route('**/api/v1/capabilities', async route => {
		reads += 1;
		if (reads === 1) {
			await initial.promise;
			await route.fallback();
			return;
		}
		await route.fulfill({ json: { timeZone: 'America/Los_Angeles', publicUrl: 'http://localhost',
			publicUrlStatus: 'configured', maxExplicitMediaItems: DEFAULT_MAX_EXPLICIT_MEDIA_ITEMS } });
	});
	try {
		await page.goto('/channels');
		await expect.poll(() => reads).toBe(1);
		await expect.poll(() => Boolean(sendReady)).toBe(true);
		const firstDay = page.waitForRequest(request => new URL(request.url()).pathname.endsWith('/schedule-guide'));
		sendReady?.();
		const query = new URL((await firstDay).url()).searchParams;
		expect(query.get('startDate')).toBe('2026-09-19');
		expect(query.get('days')).toBe('1');
	}
	finally {
		initial.resolve();
	}
});

test('restores Channels guide history after retrying a failed initial load', async ({ page }) => {
	await page.clock.setFixedTime(new Date(now));
	await installGuideFixture(page, 1, 24);
	let failed = false;
	await page.route('**/api/v1/schedule-guide?*', async route => {
		if (!failed) {
			failed = true;
			await route.fulfill({ status: 503, json: { message: 'Guide fixture unavailable' } });
		}
		else {
			await route.fallback();
		}
	});
	await page.goto('/channels');
	await page.getByRole('button', { name: 'Retry guide' }).click();
	await expect(page.locator('.guide-programme').first()).toBeVisible();

	const nextDay = '2026-09-21';
	const restored = page.waitForRequest(request => {
		const url = new URL(request.url());
		return url.pathname.endsWith('/schedule-guide') && url.searchParams.get('startDate') === nextDay;
	});
	await page.evaluate(startDate => {
		history.pushState(history.state, '', `/channels?startDate=${startDate}`);
		window.dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
	}, nextDay);
	await restored;
});

test('Quick Setup shows actionable scenarios without requesting scheduling health', async ({ page }) => {
	await installGuideFixture(page, 1);
	const overview = deferred();
	let reads = 0;
	await page.route('**/api/v1/scheduling/overview*', async route => {
		reads += 1;
		await overview.promise;
		await route.fallback();
	});
	try {
		await page.goto('/quick');
		await page.getByRole('button', { name: /Movie Channel/ }).click();
		await expect(page.getByRole('heading', { name: 'Choose a media library' })).toBeVisible();
		expect(reads).toBe(0);
	}
	finally {
		overview.resolve();
	}
});

for (const path of ['/quick', '/schedules/programs/new']) {
	test(`initializes ${path} as soon as the authoritative library refresh finishes`, async ({ page }) => {
		await installGuideFixture(page, 1);
		const initial = deferred();
		const refresh = deferred();
		let requests = 0;
		let sendReady: (() => void) | undefined;
		await page.routeWebSocket('**/api/v1/events', socket => {
			sendReady = () => socket.send(JSON.stringify({ type: 'system.ready', protocolVersion: LIVE_EVENT_PROTOCOL_VERSION,
				eventId: libraryId, occurredAt: now, data: { connectionId: libraryId } }));
		});
		await page.route('**/api/v1/libraries', async route => {
			requests += 1;
			await (requests === 1 ? initial.promise : refresh.promise);
			await route.fulfill({ json: [library] });
		});
		try {
			await page.goto(path);
			await expect.poll(() => requests).toBe(1);
			await expect.poll(() => Boolean(sendReady)).toBe(true);
			sendReady?.();
			await expect.poll(() => requests).toBe(2);
			refresh.resolve();

			if (path === '/quick') {
				await page.getByRole('button', { name: /Movie Channel/ }).click();
				await expect(page.getByRole('combobox', { name: 'Library' })).toHaveValue(libraryId);
			}
			else {
				await expect(page.getByRole('textbox', { name: 'Name' })).toBeVisible();
				await expect(page.getByRole('combobox', { name: 'Library' })).toHaveValue(libraryId);
			}
		}
		finally {
			initial.resolve();
			refresh.resolve();
		}
	});
}

for (const [identity, name] of [['new', ''], [programId, program.name]] as const) {
	test(`opens the ${name ? 'saved' : 'new'} Program form while overview and genres are pending`, async ({ page }) => {
		await installGuideFixture(page);
		const overview = deferred();
		const genres = deferred();
		let genreReads = 0;
		await page.route('**/api/v1/libraries', route => route.fulfill({ json: [library] }));
		await page.route('**/api/v1/programs', route => route.fulfill({ json: [program] }));
		await page.route(/\/api\/v1\/scheduling\/overview$/, async route => {
			await overview.promise;
			await route.fallback();
		});
		await page.route('**/api/v1/libraries/*/media-genres', async route => {
			genreReads += 1;
			await genres.promise;
			await route.fulfill({ json: [] });
		});
		try {
			await page.goto(`/schedules/programs/${identity}`);
			const field = page.getByRole('textbox', { name: 'Name' });
			await expect(field).toHaveValue(name);
			await field.fill('Edited before filtering completes');
			await expect.poll(() => genreReads).toBe(1);
		}
		finally {
			overview.resolve();
			genres.resolve();
		}
	});
}

test('retries a failed program definition read and distinguishes a missing Program', async ({ page }) => {
	await installGuideFixture(page);
	await page.route('**/api/v1/libraries', route => route.fulfill({ json: [library] }));
	let reads = 0;
	await page.route('**/api/v1/programs', route => {
		reads += 1;
		return reads === 1
			? route.fulfill({ status: 503, json: { message: 'Definitions unavailable' } })
			: route.fulfill({ json: [program] });
	});
	await page.goto(`/schedules/programs/${programId}`);
	await expect(page.getByRole('alert')).toContainText('Definitions unavailable');
	await page.getByRole('alert').getByRole('button', { name: 'Retry' }).click();
	await expect(page.getByRole('textbox', { name: 'Name' })).toHaveValue(program.name);
	await page.goto(`/schedules/programs/${otherProgramId}`);
	await expect(page.getByRole('alert')).toContainText('Program not found');
	await expect(page.getByRole('textbox', { name: 'Name' })).toHaveCount(0);
});

test('keeps the currently routed Program when an older definition read finishes late', async ({ page }) => {
	await installGuideFixture(page);
	await page.route('**/api/v1/libraries', route => route.fulfill({ json: [library] }));
	const older = deferred();
	const olderCompleted = deferred();
	const other = { ...program, id: otherProgramId, name: 'Second Program' };
	let reads = 0;
	await page.route('**/api/v1/programs', async route => {
		reads += 1;
		if (reads === 1) {
			await older.promise;
			await route.fulfill({ json: [program] });
			olderCompleted.resolve();
		}
		else {
			await route.fulfill({ json: [other] });
		}
	});
	try {
		await page.goto(`/schedules/programs/${programId}`);
		await expect.poll(() => reads).toBe(1);
		await page.evaluate(id => {
			history.pushState(history.state, '', `/schedules/programs/${id}`);
			window.dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
		}, otherProgramId);
		const field = page.getByRole('textbox', { name: 'Name' });
		await expect(field).toHaveValue(other.name);
		older.resolve();
		await olderCompleted.promise;
		await expect(field).toHaveValue(other.name);
	}
	finally {
		older.resolve();
	}
});
