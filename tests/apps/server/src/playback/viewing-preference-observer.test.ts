import { describe, expect, it, vi } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import type { Repository } from '@server/repository/index.js';
import { ViewingPreferenceObserver } from '@server/playback/viewing-preference-observer.js';

/** Let the observer's intentionally detached request queue settle. */
async function settle(): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(resolve));
	await new Promise<void>((resolve) => setImmediate(resolve));
}

describe('viewing preference observer', () => {
	it('scores one initial encounter only after two minutes and deduplicates later requests', async () => {
		const recordViewingPreference = vi.fn();
		const repository = {
			listMaterializedTimelineSegments: vi.fn(async () => [{
				segment: {
					id: 'segment-1',
					channelId: 'channel-1',
					mediaItemId: 'item-1',
					role: 'primary',
					start: '2026-01-01T00:00:00.000Z',
					finish: '2026-01-01T01:00:00.000Z',
				},
			}]),
			recordViewingPreference,
		} as unknown as Repository;
		const logger = { warn: vi.fn() } as unknown as FastifyBaseLogger;
		const observer = new ViewingPreferenceObserver(repository, logger, true);
		const client = { key: 'transient', started: true };
		const startedAt = Date.parse('2026-01-01T00:10:00.000Z');
		observer.observe('channel-1', client, startedAt);
		observer.observe('channel-1', { ...client, started: false }, startedAt + 60_000);
		observer.observe('channel-1', { ...client, started: false }, startedAt + 119_999);
		await settle();
		expect(recordViewingPreference).not.toHaveBeenCalled();

		observer.observe('channel-1', { ...client, started: false }, startedAt + 120_000);
		observer.observe('channel-1', { ...client, started: false }, startedAt + 130_000);
		await settle();
		expect(recordViewingPreference).toHaveBeenCalledOnce();
		expect(recordViewingPreference).toHaveBeenCalledWith(
			'item-1',
			2,
			'initial',
			'2026-01-01T00:12:00.000Z',
		);
	});

	it('scores a later item as one point after its own qualification window', async () => {
		const recordViewingPreference = vi.fn();
		let segment = {
			id: 'segment-1',
			mediaItemId: 'item-1',
			finish: '2026-01-01T00:12:05.000Z',
		};
		const repository = {
			listMaterializedTimelineSegments: vi.fn(async () => [{
				segment: {
					...segment,
					channelId: 'channel-1',
					role: 'primary',
					start: '2026-01-01T00:00:00.000Z',
				},
			}]),
			recordViewingPreference,
		} as unknown as Repository;
		const observer = new ViewingPreferenceObserver(
			repository,
			{ warn: vi.fn() } as unknown as FastifyBaseLogger,
			true,
		);
		const startedAt = Date.parse('2026-01-01T00:10:00.000Z');
		observer.observe('channel-1', { key: 'transient', started: true }, startedAt);
		observer.observe('channel-1', { key: 'transient', started: false }, startedAt + 60_000);
		observer.observe('channel-1', { key: 'transient', started: false }, startedAt + 120_000);
		await settle();
		segment = {
			id: 'segment-2',
			mediaItemId: 'item-2',
			finish: '2026-01-01T01:00:00.000Z',
		};
		observer.observe('channel-1', { key: 'transient', started: false }, startedAt + 130_000);
		observer.observe('channel-1', { key: 'transient', started: false }, startedAt + 190_000);
		observer.observe('channel-1', { key: 'transient', started: false }, startedAt + 250_000);
		await settle();
		expect(recordViewingPreference).toHaveBeenNthCalledWith(
			2,
			'item-2',
			1,
			'continued',
			'2026-01-01T00:14:10.000Z',
		);
	});
});
