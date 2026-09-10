import { describe, expect, it } from 'vitest';
import { channelCreateSchema } from '@moirai/shared';
import {
	ETV_CONTRACT_REVISION,
	ETV_PLAYOUT_VERSION,
	toEtvChannelConfig,
	toEtvPlayout,
	type EtvCompatibleChannel,
	validateEtvDocument,
} from '@ersatztv-source/index.js';

function channel(): EtvCompatibleChannel {
	const config = channelCreateSchema.parse({ number: '7', name: 'Moirai Cinema' });
	return {
		...config,
		video: { ...config.video, accel: null },
		id: crypto.randomUUID(),
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	};
}

describe('ErsatzTV adapter', () => {
	it('supports local fallback video with an explicit silent audio track', () => {
		const document = toEtvPlayout([{
			type: 'local',
			id: 'silent-fallback',
			start: '2026-01-01T00:00:00Z',
			finish: '2026-01-01T00:01:00Z',
			path: '/fallback/silent.mp4',
			inPointMs: null,
			outPointMs: 60_000,
			silentAudio: true,
		}]);

		expect(document).toMatchObject({
			items: [{
				source: { source_type: 'local', path: '/fallback/silent.mp4' },
				tracks: { audio: { source: { source_type: 'lavfi' } } },
			}],
		});
	});

	it('maps domain normalization to the pinned contract', () => {
		const document = toEtvChannelConfig(channel());
		expect(document).toMatchObject({
			normalization: {
				audio: { format: 'aac' },
				video: { format: 'h264', scaling_mode: 'scale_and_pad' },
			},
		});
		expect(() => validateEtvDocument('channel', document)).not.toThrow();
		expect(ETV_CONTRACT_REVISION).toMatch(/^[a-f0-9]{40}$/);
	});

	it('maps local media and dead air into the pinned playout contract', () => {
		const document = toEtvPlayout([
			{
				type: 'local',
				id: 'media-1',
				start: '2026-08-23T12:00:00Z',
				finish: '2026-08-23T13:00:00Z',
				path: '/media/movie.mkv',
				inPointMs: 30_000,
				outPointMs: 3_630_000,
			},
			{
				type: 'dead-air',
				id: 'dead-air-1',
				start: '2026-08-23T13:00:00Z',
				finish: '2026-08-23T14:00:00Z',
				width: 1920,
				height: 1080,
			},
		]);

		expect(document).toMatchObject({
			version: ETV_PLAYOUT_VERSION,
			items: [
				{ source: { source_type: 'local', in_point_ms: 30_000, out_point_ms: 3_630_000 } },
				{ tracks: { video: { source: { source_type: 'lavfi' } } } },
			],
		});
		expect(() => validateEtvDocument('playout', document)).not.toThrow();
	});
});

it('preserves subtitle source timing and simultaneous silent audio overrides', () => {
	const document = toEtvPlayout([{ type: 'local', id: 'credits', start: '2026-01-01T00:00:00Z', finish: '2026-01-01T00:01:00Z', path: '/video.mp4',
		inPointMs: 10_000, outPointMs: 70_000, silentAudio: true, subtitle: { path: '/credits.ass', offsetMs: 90_000 } }]);
	expect(document).toMatchObject({ items: [{ tracks: { audio: { source: { source_type: 'lavfi' } }, subtitle: { source: { source_type: 'local', path: '/credits.ass', in_point_ms: 100_000, out_point_ms: 160_000 } } } }] });
});
