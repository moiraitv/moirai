import { canonicalChannelNumberKey, canonicalIdentityKey, type Channel } from '@moirai/shared';

/** Find conflicts and up to three naturally sorted prefix matches, excluding the edited channel. */
export function channelNumberSuggestions(channels: Channel[], number: string, editingId?: string) {
	const prefix = canonicalChannelNumberKey(number);
	const matches = prefix ? channels.filter(channel => channel.id !== editingId
		&& canonicalChannelNumberKey(channel.number).startsWith(prefix)) : [];
	const duplicate = matches.find(channel => canonicalChannelNumberKey(channel.number) === prefix);
	matches.sort((left, right) => Number(right === duplicate) - Number(left === duplicate)
		|| left.number.localeCompare(right.number, undefined, { numeric: true }));
	return { duplicate, matches: matches.slice(0, 3) };
}

/** Offer distinct existing groups while retaining their user-facing spelling. */
export function channelGroupSuggestions(channels: Channel[]): string[] {
	const groups = new Map<string, string>();
	for (const channel of channels) {
		const group = channel.group?.trim();
		if (group && !groups.has(canonicalIdentityKey(group))) {
			groups.set(canonicalIdentityKey(group), group);
		}
	}
	return [...groups.values()].sort((left, right) => left.localeCompare(right));
}
