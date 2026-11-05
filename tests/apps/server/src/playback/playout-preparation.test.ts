import { afterEach, expect, it, vi } from 'vitest';
import { channelSchema } from '@moirai/shared/api-contracts';
import { playbackSettingsSchema, type ScheduleGuide, type SchedulingProgram, type TimelineSegment } from '@moirai/shared';
import * as guides from '@server/guide/schedule-guide.js';
import { PlayoutPreparationReader, type PlayoutPreparation } from '@server/playback/playout-preparation.js';
import type { Repository } from '@server/repository/index.js';

afterEach(() => vi.restoreAllMocks());

it('keeps full guides and Program sources private while returning only asset spans and preferences', async () => {
	const channel = channelSchema.parse({ id: '00000000-0000-4000-8000-000000000001', number: '1', name: 'Test', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' });
	const programs = [
		{ id: 'off', config: { type: 'content', source: { itemIds: Array.from({ length: 5000 }, (_, index) => String(index)) } } },
		{ id: 'on', config: { type: 'content', subtitlePreferences: { policy: 'any' }, source: { itemIds: ['item'] } } },
	] as unknown as SchedulingProgram[];
	const guide = { channels: [{ channelId: channel.id, preview: { segments: [
		{ id: 'ordinary', mediaItemId: 'item', programId: 'off' },
		{ id: 'asset', mediaItemId: 'item', programId: 'on' },
	] } }] } as unknown as ScheduleGuide;
	const read = vi.spyOn(guides, 'readCommittedChannelScheduleGuide').mockResolvedValue(guide);
	const repository = { graphics: { assignments: () => new Map() }, getChannel: vi.fn(async () => channel), listPrograms: vi.fn(async () => programs), getPlaybackSettings: vi.fn(async () => playbackSettingsSchema.parse({})) } as unknown as Repository;
	const reader = new PlayoutPreparationReader(repository);
	const request = { kind: 'playout-preparation' as const, channelId: channel.id, startDate: '2026-01-01', days: 3, timeZone: 'UTC' };
	const result = await reader.read(request) as PlayoutPreparation;
	expect(result.guide.channels[0]?.preview.segments.map(span => span.id)).toEqual(['asset']);
	expect(result.programs).toEqual([{ id: 'on', config: { subtitlePreferences: { policy: 'any' } } }]);
	expect(guide.channels[0]?.preview.segments).toHaveLength(2);
	await reader.read(request);
	expect(read).toHaveBeenCalledOnce();
	expect(repository.getPlaybackSettings).toHaveBeenCalledOnce();
	reader.invalidate();
	await reader.read(request);
	expect(read).toHaveBeenCalledTimes(2);
	expect(repository.getPlaybackSettings).toHaveBeenCalledTimes(2);
});


it('publishes global audio defaults from a cached snapshot and reloads them after invalidation', async () => {
	const channel = channelSchema.parse({ id: '00000000-0000-4000-8000-000000000001', number: '1', name: 'Test', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' });
	const segment = { id: 'segment', channelId: channel.id, mediaItemId: 'item', playbackPath: '/movie.mkv',
		role: 'primary', title: 'Movie', start: '2026-01-01T00:00:00Z', finish: '2026-01-01T00:01:00Z',
		sourceStartSeconds: 0, sourceFinishSeconds: 60 } as TimelineSegment;
	const guide = { timeZone: 'UTC', startDate: '2026-01-01', days: 1,
		channels: [{ channelId: channel.id, preview: { segments: [segment] } }] } as ScheduleGuide;
	vi.spyOn(guides, 'readCommittedChannelScheduleGuide').mockResolvedValue(guide);
	let settings = playbackSettingsSchema.parse({ audioPreferences: { language: 'fr' } });
	const readSettings = vi.fn(async () => settings);
	const repository = { graphics: { assignments: () => new Map() }, getChannel: async () => channel, listPrograms: async () => [], getPlaybackSettings: readSettings,
		audioMetadata: async () => new Map([['/movie.mkv', { streams: [
			{ type: 'audio', index: 1, language: 'eng' }, { type: 'audio', index: 2, language: 'fra' },
		] }]]) } as unknown as Repository;
	const reader = new PlayoutPreparationReader(repository);
	const request = { kind: 'playout-documents' as const, channelId: channel.id, startDate: '2026-01-01', days: 1, timeZone: 'UTC',
		fallback: { path: '/fallback.mp4', durationMilliseconds: 60_000, hasAudio: true } };
	const first = await reader.read(request) as Map<string, string>;
	expect(JSON.parse([...first.values()][0]!).items.find((item: { source: { path: string } }) => item.source.path === '/movie.mkv').tracks.audio.stream_index).toBe(2);
	settings = playbackSettingsSchema.parse({ audioPreferences: { language: 'en' } });
	expect(await reader.read(request)).toEqual(first);
	expect(readSettings).toHaveBeenCalledOnce();
	reader.invalidate();
	const refreshed = await reader.read(request) as Map<string, string>;
	expect(JSON.parse([...refreshed.values()][0]!).items.find((item: { source: { path: string } }) => item.source.path === '/movie.mkv').tracks.audio.stream_index).toBe(1);
	expect(readSettings).toHaveBeenCalledTimes(2);
});

it('returns graphics metadata for committed primary spans and authored rolls without subtitle work', async () => {
	const channel = channelSchema.parse({
		id: '00000000-0000-4000-8000-000000000001', number: '1', name: 'Test',
		graphicsPresetId: '2cd52ff4-16dc-4349-9000-166b643d1001',
		createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
	});
	const primary = { id: 'programme', role: 'primary', title: 'Feature', playbackPath: '/feature.mp4' };
	// Stored rolls retain their airing envelope and can omit the transient filler stage.
	const roll = { id: 'bumper', role: 'filler', title: 'Bumper', airing: { id: 'airing' }, playbackPath: '/bumper.mp4' };
	const fallback = { id: 'gap', role: 'filler', title: 'Filler', playbackPath: '/fallback.mp4' };
	const guide = { channels: [{ channelId: channel.id, preview: { segments: [primary, roll, fallback] } }] } as unknown as ScheduleGuide;
	vi.spyOn(guides, 'readCommittedChannelScheduleGuide').mockResolvedValue(guide);
	const preparePresets = vi.fn(() => new Map());
	const repository = { graphics: { assignments: () => new Map(), preparePresets }, getChannel: async () => channel, listPrograms: async () => [],
		getPlaybackSettings: async () => playbackSettingsSchema.parse({}) } as unknown as Repository;
	const reader = new PlayoutPreparationReader(repository);
	const result = await reader.read({ kind: 'playout-preparation', channelId: channel.id,
		startDate: '2026-01-01', days: 3, timeZone: 'UTC' }) as PlayoutPreparation;
	expect(result.guide.channels[0]?.preview.segments).toEqual([]);
	expect(preparePresets).toHaveBeenCalledExactlyOnceWith(new Set([channel.graphicsPresetId]));
	expect(result.graphics?.segments.map(span => span.id)).toEqual([primary.id, roll.id]);
	expect(result.graphics?.segments[1]).toMatchObject({ role: 'filler', airing: roll.airing });
	expect(result.graphics?.segments[0]).not.toHaveProperty('playbackPath');
});
