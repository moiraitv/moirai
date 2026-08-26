import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { LIVE_EVENT_PROTOCOL_VERSION, type LiveEvent } from '@moirai/shared';
import { affectsGuide } from '@web/guide-events';

function event(value: Omit<LiveEvent, 'protocolVersion' | 'eventId' | 'occurredAt'>): LiveEvent {
	return {
		protocolVersion: LIVE_EVENT_PROTOCOL_VERSION,
		eventId: randomUUID(),
		occurredAt: new Date().toISOString(),
		...value,
	} as LiveEvent;
}

describe('guide live refresh', () => {
	it('refreshes for programming-affecting scans but not watcher or playback status', () => {
		expect(
			affectsGuide(
				event({
					type: 'scan.changed',
					data: {
						libraryId: randomUUID(),
						scanId: randomUUID(),
						trigger: 'periodic',
						status: 'failed',
						startedAt: new Date().toISOString(),
						completedAt: new Date().toISOString(),
						discoveredCount: 0,
						changedCount: 0,
						removedCount: 0,
						issueCount: 1,
						affectsProgramming: true,
					},
				}),
			),
		).toBe(true);
		expect(affectsGuide(event({
			type: 'playback.changed',
			data: { channelId: null, reason: 'settings-changed' },
		}))).toBe(false);
		expect(
			affectsGuide(
				event({
					type: 'library.changed',
					data: { libraryId: randomUUID(), change: 'watcher-status', watcherStatus: 'ready' },
				}),
			),
		).toBe(false);
	});
});
