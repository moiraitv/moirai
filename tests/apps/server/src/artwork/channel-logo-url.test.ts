import { describe, expect, it } from 'vitest';
import {
	channelCreateSchema,
	managedChannelLogoUri,
	type Channel,
} from '@moirai/shared';
import { publicChannelLogoUrl } from '@server/artwork/channel-logo-url.js';

const CHANNEL_ID = 'd3cbfbd0-55ed-48c6-8306-716f74876d69';
const UPDATED_AT = '2026-08-21T12:34:56.000Z';

/** Create a valid channel with the logo under test. */
function channel(logo: string | null): Channel {
	return {
		...channelCreateSchema.parse({ number: '601.1', name: 'Channel' }),
		id: CHANNEL_ID,
		logo,
		createdAt: '2026-08-21T12:00:00.000Z',
		updatedAt: UPDATED_AT,
	};
}

describe('public channel logo URLs', () => {
	it('resolves managed logos against the public origin', () => {
		expect(
			publicChannelLogoUrl(
				channel(managedChannelLogoUri(CHANNEL_ID)),
				'https://moirai.example.test',
			),
		).toBe(
			`https://moirai.example.test/api/v1/channels/${CHANNEL_ID}/logo?v=${encodeURIComponent(UPDATED_AT)}`,
		);
	});

	it('replaces stale external versions while preserving other parameters', () => {
		expect(
			publicChannelLogoUrl(
				channel('https://images.example.test/logo.png?size=large&v=stale'),
				'https://moirai.example.test',
			),
		).toBe(
			`https://images.example.test/logo.png?size=large&v=${encodeURIComponent(UPDATED_AT)}`,
		);

		expect(publicChannelLogoUrl(channel(null), 'https://moirai.example.test')).toBeNull();
	});
});
