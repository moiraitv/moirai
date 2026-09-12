import { randomUUID } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import { expect, test } from '@playwright/test';
import { SECONDS_PER_SCHEDULING_DAY, type ScheduleGuide, type TimelineSegment } from '@moirai/shared';
import { authenticateAdministrator } from './authentication';

for (const todayHasGap of [false, true]) {
	test(`cached guide summaries cover upcoming time (upcoming gap: ${todayHasGap})`, async ({ page }) => {
		const csrfToken = await authenticateAdministrator(page);
		const frozenNow = new Date('2026-09-03T19:00:00Z');
		await page.clock.install({ time: frozenNow });
		const headers = { 'x-moirai-csrf': csrfToken };
		const channelName = `Cached guide ${randomUUID()}`;
		const channelResponse = await page.request.post('/api/v1/channels', {
			headers, data: { number: todayHasGap ? '98.9' : '98.8', name: channelName },
		});
		expect(channelResponse.ok()).toBe(true);
		const channel = await channelResponse.json() as { id: string };
		const slotId = randomUUID();
		const templateResponse = await page.request.post('/api/v1/schedule-templates', {
			headers,
			data: {
				name: channelName,
				slots: [{ id: slotId, startSeconds: 0, programId: null, filler: { mode: 'disabled' } }],
				boundaries: [{
					id: randomUUID(), leftSlotId: slotId, rightSlotId: slotId,
					targetSeconds: SECONDS_PER_SCHEDULING_DAY, policy: 'hard',
				}],
			},
		});
		expect(templateResponse.ok()).toBe(true);
		const template = await templateResponse.json() as { id: string };
		const scheduleResponse = await page.request.put(`/api/v1/channels/${channel.id}/schedule`, {
			headers, data: { defaultTemplateId: template.id },
		});
		expect(scheduleResponse.ok()).toBe(true);
		const capabilities = await page.request.get('/api/v1/capabilities');
		const { timeZone } = await capabilities.json() as { timeZone: string };
		const guideRequests: number[] = [];

		// Supply a cached week with elapsed, ongoing, and beyond-window gaps.
		await page.route('**/api/v1/schedule-guide?*', async (route) => {
			const query = new URL(route.request().url()).searchParams;
			const startDate = query.get('startDate')!;
			const days = Number(query.get('days'));
			guideRequests.push(days);
			const date = Temporal.PlainDate.from(startDate);
			const start = date.toZonedDateTime(timeZone).toInstant();
			const now = Temporal.Instant.from(frozenNow.toISOString());
			const finish = now.add({ hours: 24 });
			const gapStart = now.subtract({ minutes: 8 });
			const gapFinish = now.add({ seconds: todayHasGap ? 12 : 0 });
			const base: TimelineSegment = {
				id: randomUUID(), channelId: channel.id, templateId: template.id, slotId,
				scheduleLayerId: null, programId: null, mediaItemId: null, playbackPath: null,
				sourceStartSeconds: 0, sourceFinishSeconds: null, truncated: false,
				role: 'primary', title: 'First-day programming', start: gapFinish.toString(), finish: finish.toString(),
			};
			const body: ScheduleGuide = {
				timeZone, startDate, days, requestedDays: days, segmentLimitApplied: false,
				channels: [{
					channelId: channel.id,
					preview: {
						channelId: channel.id, timeZone, startDate, days, proposedState: [],
						segments: [
							base,
							{ ...base, id: randomUUID(), role: 'dead-air', start: start.toString(), finish: now.subtract({ hours: 2 }).toString() },
							{ ...base, id: randomUUID(), role: 'dead-air', start: gapStart.toString(), finish: gapFinish.toString() },
							{ ...base, id: randomUUID(), role: 'dead-air', start: finish.add({ hours: 2 }).toString(), finish: finish.add({ hours: 2, minutes: 8 }).toString() },
						],
						issues: [{
							code: 'boundary-start-rejected', message: 'Review this boundary.',
							templateId: template.id, slotId, scheduleLayerId: null, programId: null, mediaItemId: null,
							occurrences: [{ start: gapStart.toString(), finish: gapFinish.toString(), boundaryOrigin: 'template' }],
						}],
					},
				}],
			};
			await route.fulfill({ json: body });
		});

		for (const path of ['/guide', '/channels']) {
			// UI interaction time must not consume the fixture's twelve-second ongoing gap.
			await page.clock.setFixedTime(frozenNow);
			await page.goto(path);
			const row = page.locator('.guide-channel-cell').filter({ hasText: channelName });
			const badge = row.getByRole('button', { name: /warning.*show details/ });
			await badge.focus();
			await page.keyboard.press('Tab');
			const panel = page.getByRole('dialog', { name: 'Scheduling warnings' });
			await expect(panel.getByRole('link', { name: 'Diagnose schedule' })).toBeFocused();
			await page.keyboard.press('Shift+Tab');
			await expect(badge).toBeFocused();
			await page.keyboard.press('Tab');
			await page.keyboard.press('Tab');
			const nextControl = path === '/channels'
				? row.getByRole('button', { name: `Edit ${channelName}`, exact: true })
				: page.getByRole('button', { name: 'First-day programming Scheduled content', exact: true });
			await expect(nextControl).toBeFocused();
			await expect(panel).toBeHidden();

			// SPA navigation reuses the covering seven-day cache.
			const requestsBeforeNavigation = guideRequests.length;
			await page.getByRole('link', { name: 'Channel Schedules', exact: true }).click();
			const card = page.locator('.schedule-channel-card').filter({ hasText: channelName });
			await expect(card.locator('.next-day')).toContainText(todayHasGap ? /1 gap · \d+ seconds dead air/ : '1 scheduled item');
			await expect(card).toHaveClass(todayHasGap ? /has-dead-air/ : /^(?!.*has-dead-air)/);
			await expect(card.locator('.next-day')).toHaveClass(todayHasGap ? /warning/ : /^(?!.*warning)/);
			expect(guideRequests).toHaveLength(requestsBeforeNavigation);
			expect(guideRequests.at(-1)).toBe(7);

			await page.clock.setFixedTime(new Date(frozenNow.getTime() + 61_000));
			await page.clock.fastForward(61_000);
			await expect(card.locator('.next-day')).toContainText('1 scheduled item');
			await expect(card).not.toHaveClass(/has-dead-air/);
			expect(guideRequests).toHaveLength(requestsBeforeNavigation);
		}
	});
}
