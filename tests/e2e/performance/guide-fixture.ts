import type { Page } from '@playwright/test';
import { channelSchema } from '@moirai/shared/api-contracts';

/** Install deterministic, isolated guide responses without touching an application database. */
export async function installGuideFixture(page: Page, channelCount = 20, segmentsPerDay = 48, grouped = false, artwork = false): Promise<void> {
	const channels = Array.from({ length: channelCount }, (_, index) => channelSchema.parse({
		id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
		number: grouped ? `1.${index + 1}` : String(index + 1), name: grouped ? `Synthetic ${index + 1} with a longer channel name that wraps across several lines` : `Synthetic ${index + 1}`,
		createdAt: '2026-09-20T00:00:00Z', updatedAt: '2026-09-20T00:00:00Z',
	}));
	await page.routeWebSocket('**/api/v1/events', () => {});
	await page.route('**/api/v1/**', async (route) => {
		const url = new URL(route.request().url());
		if (url.pathname.endsWith('/fixture-artwork')) {
			await route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="#176b85"/></svg>' });
			return;
		}
		let data: unknown = [];
		if (url.pathname.endsWith('/auth/session')) {
			data = { status: 'authenticated', csrfToken: 'synthetic', identity: null };
		}
		else if (url.pathname.endsWith('/channels')) {
			data = channels;
		}
		else if (url.pathname.endsWith('/playback/status')) {
			data = { status: 'ready', activeSessionCount: 0, maxActiveSessions: 4, sessions: [] };
		}
		else if (url.pathname.endsWith('/capabilities')) {
			data = { timeZone: 'UTC', publicUrl: 'http://localhost', publicUrlStatus: 'configured' };
		}
		else if (url.pathname.endsWith('/scheduling/overview')) {
			data = { programs: [], templates: [], channelSchedules: [] };
		}
		else if (url.pathname.endsWith('/schedule-guide')) {
			const startDate = url.searchParams.get('startDate')!;
			const days = Number(url.searchParams.get('days'));
			const start = Date.parse(`${startDate}T00:00:00Z`);
			data = {
				startDate, days, requestedDays: days, timeZone: 'UTC', segmentLimitApplied: false,
				channels: channels.map(channel => {
					const segments = Array.from({ length: days * segmentsPerDay }, (_, index) => ({
						id: `${channel.id}-${index}`, channelId: channel.id, programId: null,
						start: new Date(start + index * 86400000 / segmentsPerDay).toISOString(),
						finish: new Date(start + (index + 1) * 86400000 / segmentsPerDay).toISOString(),
						title: `Programme ${index}`, role: 'dead-air', truncated: false,
						...(artwork ? { landscapeUrl: '/api/v1/fixture-artwork', posterUrl: '/api/v1/fixture-artwork', fanartUrl: '/api/v1/fixture-artwork' } : {}),
					}));
					return {
						channelId: channel.id,
						preview: { segments, issues: [], programNames: {}, startDate, days, timeZone: 'UTC' },
						...(grouped ? { entries: segments.filter((_, index) => index % 6 === 0).map(segment => ({
							...segment, id: `block-${segment.id}`, kind: 'block', title: 'Synthetic block', description: '',
							finish: new Date(Date.parse(segment.start) + 6 * 86400000 / segmentsPerDay).toISOString(),
							segmentId: null, occurrenceId: null,
						})) } : {}),
					};
				}),
			};
		}
		await route.fulfill({ json: data });
	});
}
