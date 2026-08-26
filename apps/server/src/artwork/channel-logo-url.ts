import {
	externalChannelLogoUrl,
	managedChannelLogoId,
	type Channel,
} from '@moirai/shared';
import { versionedPublicUrl } from '../routes/public-url.js';

/** Resolve a channel logo to an absolute public URL with its cache version. */
export function publicChannelLogoUrl(channel: Channel, publicUrl: string): string | null {
	const managedId = managedChannelLogoId(channel.logo);
	const value = managedId
		? `/api/v1/channels/${managedId}/logo`
		: externalChannelLogoUrl(channel.logo);
	if (!value) {
		return null;
	}

	return versionedPublicUrl(publicUrl, value, channel.updatedAt);
}
