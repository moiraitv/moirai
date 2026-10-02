import { afterEach, expect, it, vi } from 'vitest';
import { channelSchema } from '@moirai/shared/api-contracts';
import type { ScheduleGuide, SchedulingProgram } from '@moirai/shared';
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
	const repository = { getChannel: vi.fn(async () => channel), listPrograms: vi.fn(async () => programs) } as unknown as Repository;
	const reader = new PlayoutPreparationReader(repository);
	const request = { kind: 'playout-preparation' as const, channelId: channel.id, startDate: '2026-01-01', days: 3, timeZone: 'UTC' };
	const result = await reader.read(request) as PlayoutPreparation;
	expect(result.guide.channels[0]?.preview.segments.map(span => span.id)).toEqual(['asset']);
	expect(result.programs).toEqual([{ id: 'on', config: { subtitlePreferences: { policy: 'any' } } }]);
	expect(guide.channels[0]?.preview.segments).toHaveLength(2);
	await reader.read(request);
	expect(read).toHaveBeenCalledOnce();
	reader.invalidate();
	await reader.read(request);
	expect(read).toHaveBeenCalledTimes(2);
});
