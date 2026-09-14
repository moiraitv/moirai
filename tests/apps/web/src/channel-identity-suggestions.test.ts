import { describe, expect, it } from 'vitest';
import type { Channel } from '@moirai/shared';
import { channelGroupSuggestions, channelNumberSuggestions } from '../../../../apps/web/src/channel-identity-suggestions';

const channels = [
	{ id: 'self', number: '10', group: 'Movies' },
	{ id: 'a', number: '10.10', group: 'movies' },
	{ id: 'b', number: '10.2', group: ' News ' },
	{ id: 'c', number: '10.1', group: null },
	{ id: 'd', number: 'ABC', group: '' },
] as Channel[];

describe('channel identity suggestions', () => {
	it('caps naturally sorted prefix matches and excludes the edited channel', () => {
		expect(channelNumberSuggestions(channels, '10', 'self').matches.map(channel => channel.number))
			.toEqual(['10.1', '10.2', '10.10']);
		expect(channelNumberSuggestions(channels, '10', 'self').duplicate).toBeUndefined();
	});

	it('prioritizes canonical exact conflicts and clears matches for empty input', () => {
		expect(channelNumberSuggestions(channels, '10').matches.map(channel => channel.number))
			.toEqual(['10', '10.1', '10.2']);
		expect(channelNumberSuggestions(channels, ' abc ').duplicate?.id).toBe('d');
		expect(channelNumberSuggestions(channels, ' ').matches).toEqual([]);
		expect(channelNumberSuggestions(channels, '9').duplicate).toBeUndefined();
	});

	it('deduplicates groups without discarding their display spelling', () => {
		expect(channelGroupSuggestions(channels)).toEqual(['Movies', 'News']);
	});
});
