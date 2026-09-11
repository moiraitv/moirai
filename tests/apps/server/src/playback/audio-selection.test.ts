import { describe, expect, it, vi } from 'vitest';
import { audioPreferencesSchema, channelCreateSchema, type Channel, type TimelineSegment, type ScheduleGuide } from '@moirai/shared';
import { audioPreferences, prepareAudio, selectAudio } from '@server/playback/audio-selection.js';
import type { Repository } from '@server/repository/index.js';

const stream = (index: number, language: string, extra = {}) => ({ type: 'audio', index, language, title: null, isDefault: false, channels: 2, ...extra });
const metadata = { streams: [stream(1, 'eng'), stream(2, 'fra', { title: 'Original Surround', channels: 6 }), stream(3, 'fre', { isDefault: true })] };

describe('audio selection', () => {
	it('preserves automatic selection without effective preferences', () => {
		expect(selectAudio(metadata, {})).toBeNull();
		expect(selectAudio(metadata, { language: null, title: null })).toBeNull();
	});
	it('matches language aliases and prefers a matching title over the default flag', () => {
		expect(selectAudio(metadata, { language: 'FR' })).toBe(3);
		expect(selectAudio(metadata, { language: 'fr', title: 'SURROUND' })).toBe(2);
		expect(selectAudio(metadata, { language: 'en', title: 'Surround' })).toBe(1);
	});
	it('falls back through language and title while preserving available audio', () => {
		expect(selectAudio(metadata, { language: 'ja', title: 'Surround' })).toBe(2);
		expect(selectAudio(metadata, { language: 'ja', title: 'absent' })).toBe(3);
	});
	it('orders defaults, channel counts, and indices deterministically', () => {
		const streams = [stream(4, 'eng', { channels: null }), stream(3, 'eng', { channels: 6 }), stream(2, 'en', { channels: 6 })];
		expect(selectAudio({ streams }, { language: 'eng' })).toBe(2);
		expect(selectAudio({ streams: [...streams, stream(5, 'eng', { isDefault: true })] }, { language: 'en' })).toBe(5);
	});
	it.each([null, {}, { streams: null }, { streams: [{ type: 'audio', index: -1 }] }])('omits selection for unusable metadata', (value) => {
		expect(selectAudio(value, { language: 'en' })).toBeNull();
	});
	it('supports legacy streams without channel counts', () => {
		expect(selectAudio({ streams: [{ type: 'audio', index: 7, language: 'en' }] }, { language: 'en' })).toBe(7);
	});
	it('validates and normalizes optional persisted preferences', () => {
		expect(audioPreferencesSchema.parse({ language: ' EN ', title: ' Surround ' })).toEqual({ language: 'en', title: 'Surround' });
		expect(audioPreferencesSchema.parse({})).toEqual({});
		expect(audioPreferencesSchema.safeParse({ title: 'x'.repeat(201) }).success).toBe(false);
		expect(audioPreferencesSchema.safeParse({ language: '../' }).success).toBe(false);
	});
	it('inherits fields independently through nested and filler program ancestry', () => {
		const channel = { ...channelCreateSchema.parse({ number: '1', name: 'Audio' }), audioPreferences: { language: 'en', title: 'Original' } } as Channel;
		const segment = { programAncestry: ['outer', 'inner', 'leaf'], role: 'filler' } as TimelineSegment;
		expect(audioPreferences(channel, segment, new Map([
			['outer', { language: 'fr' }], ['inner', { title: null }], ['leaf', { language: 'ja' }],
		]))).toEqual({ language: 'ja', title: null });
	});
	it('selects different multipart indices with one metadata lookup and skips inactive preferences', async () => {
		const channel = { ...channelCreateSchema.parse({ number: '1', name: 'Audio' }), id: 'channel', audioPreferences: { language: 'fr' } } as Channel;
		const segment = { id: 'segment', channelId: 'channel', mediaItemId: 'media', playbackParts: [{ playbackPath: '/one' }, { playbackPath: '/two' }] } as TimelineSegment;
		const guide = { channels: [{ preview: { segments: [segment] } }] } as ScheduleGuide;
		const read = vi.fn(async () => new Map([['/one', metadata], ['/two', { streams: [stream(8, 'fra')] }]]));
		const repository = { audioMetadata: read } as unknown as Repository;
		expect((await prepareAudio(repository, channel, guide, [])).get('segment')).toEqual([3, 8]);
		expect(read).toHaveBeenCalledOnce();
		await prepareAudio(repository, { ...channel, audioPreferences: {} }, guide, []);
		expect(read).toHaveBeenCalledOnce();
		read.mockRejectedValueOnce(new Error('unavailable'));
		expect(await prepareAudio(repository, channel, guide, [])).toEqual(new Map());
	});
});
