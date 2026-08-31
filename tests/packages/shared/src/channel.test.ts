import { describe, expect, it } from 'vitest';
import {
	CHANNEL_EXTERNAL_LOGO_MAX_LENGTH,
	channelCreateSchema,
	channelUpdateSchema,
	effectiveChannelTvgId,
	playbackSettingsSchema,
} from '@shared-source/index.js';

describe('channel external contracts', () => {
	it('defaults new channels to Automatic while preserving explicit None', () => {
		expect(channelCreateSchema.parse({ number: '1', name: 'Automatic' }).video.accel).toBe(
			'automatic',
		);
		expect(channelCreateSchema.parse({
			number: '2',
			name: 'None',
			video: { accel: null },
		}).video.accel).toBeNull();
	});

	it('accepts only bounded credential-free HTTP(S) external logos', () => {
		expect(
			channelCreateSchema.safeParse({
				number: '1',
				name: 'Safe',
				logo: 'https://example.test/logo.png',
			}).success,
		).toBe(true);
		for (const logo of [
			'javascript:alert(1)',
			'data:image/png;base64,AA==',
			'file:///tmp/logo.png',
			'https://user:secret@example.test/logo.png',
			`https://example.test/${'x'.repeat(CHANNEL_EXTERNAL_LOGO_MAX_LENGTH)}`,
		]) {
			expect(channelCreateSchema.safeParse({ number: '1', name: 'Unsafe', logo }).success).toBe(
				false,
			);
		}
	});

	it('derives the authoritative TVG identifier from the channel number and UUID', () => {
		expect(
			effectiveChannelTvgId({
				id: '3a9bb80f-e7a0-4fa9-ad69-e67e92473e25',
				number: '100.2',
			}),
		).toBe('C100.2.3a9bb80f.moirai.tv');
	});

	it('rejects TVG identifier overrides outside the channel contract', () => {
		expect(channelCreateSchema.safeParse({
			number: '100.2',
			name: 'Example',
			tvgId: 'custom.id',
		}).success).toBe(false);
		expect(channelUpdateSchema.safeParse({ tvgId: 'custom.id' }).success).toBe(false);
	});

	it('rejects channel numbers that are relative path segments', () => {
		for (const number of ['.', '..']) {
			expect(channelCreateSchema.safeParse({ number, name: 'Unsafe' }).success).toBe(false);
		}
		expect(channelCreateSchema.safeParse({ number: '100.1', name: 'Safe' }).success).toBe(true);
	});

	it('bounds the configurable concurrent playback capacity', () => {
		expect(playbackSettingsSchema.parse({})).toEqual({
			maxActiveSessions: 4,
			viewingPreferencesEnabled: true,
		});
		expect(playbackSettingsSchema.safeParse({ maxActiveSessions: 32 }).success).toBe(true);
		expect(playbackSettingsSchema.safeParse({ maxActiveSessions: 33 }).success).toBe(false);
	});
});
