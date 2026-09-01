import type { DiscoveredItem } from '../repository/contracts.js';

/** Select stable persisted item fields whose normalized output must invalidate the catalog. */
export function normalizedItemMetadata(item: DiscoveredItem): Record<string, unknown> {
	const metadata = { ...item } as Partial<DiscoveredItem>;
	delete metadata.aliasIds;
	delete metadata.fingerprint;
	delete metadata.probeUpdatedAt;
	delete metadata.fileModifiedAt;
	return metadata as Record<string, unknown>;
}
