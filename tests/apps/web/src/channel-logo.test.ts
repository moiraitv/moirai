import { describe, expect, it } from 'vitest';
import { channelCreateSchema, managedChannelLogoUri, type Channel } from '@moirai/shared';
import { channelLogoUrl } from '@web/channel-logo';

const CHANNEL_ID = 'd3cbfbd0-55ed-48c6-8306-716f74876d69';

function channel(logo: string | null): Channel {
	return {
		...channelCreateSchema.parse({ number: '1', name: 'Channel' }),
		id: CHANNEL_ID,
		logo,
		createdAt: '2026-08-21T12:00:00.000Z',
		updatedAt: '2026-08-21T12:34:56.000Z',
	};
}

describe('channel logo URLs', () => {
	it('routes managed artwork through the channel logo endpoint with a revision', () => {
		expect(channelLogoUrl(channel(managedChannelLogoUri(CHANNEL_ID)))).toBe(
			`/api/v1/channels/${CHANNEL_ID}/logo?v=2026-08-21T12%3A34%3A56.000Z`,
		);
	});

	it('preserves external artwork URLs and missing logos', () => {
		const external = 'https://example.test/channel.png';
		expect(channelLogoUrl(channel(external))).toBe(external);
		expect(channelLogoUrl(channel(null))).toBeNull();
	});
});
