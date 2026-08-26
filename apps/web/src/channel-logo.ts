import { externalChannelLogoUrl, managedChannelLogoId, type Channel } from '@moirai/shared';

/** Resolve managed logos through the cache-versioned API while preserving safe external URLs. */
export function channelLogoUrl(channel: Channel): string | null {
	const managedId = managedChannelLogoId(channel.logo);
	if (managedId) {
		return `/api/v1/channels/${managedId}/logo?v=${encodeURIComponent(channel.updatedAt)}`;
	}

	return externalChannelLogoUrl(channel.logo);
}
