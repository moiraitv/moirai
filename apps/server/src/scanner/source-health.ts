import { createHash } from 'node:crypto';
import { MAJOR_REMOVAL_COUNT, MAJOR_REMOVAL_RATIO, type SourceIdentity } from '@moirai/shared';

/**
 * Produce the stable opaque value used to bind observations to one configured source location.
 * Device and inode values remain scan diagnostics because operating systems may change them after
 * a harmless remount.
 */
export function sourceIdentityHash(identity: SourceIdentity): string {
	return createHash('sha256')
		.update([identity.sourceType, identity.sourceKey].join('\0'))
		.digest('hex');
}

/** Bind an operator-reviewed candidate to its exact set of discovered media paths. */
export function sourceManifest(paths: string[]): string {
	const hash = createHash('sha256');
	for (const entry of [...paths].sort()) {
		hash.update(entry);
		hash.update('\0');
	}
	return hash.digest('hex');
}

/** Large or empty source changes require explicit confirmation rather than automatic expiry. */
export function isMajorRemoval(
	existingCount: number,
	discoveredCount: number,
	missingCount: number,
): boolean {
	if (existingCount === 0 || missingCount === 0) {
		return false;
	}

	if (discoveredCount === 0) {
		return true;
	}

	return missingCount > MAJOR_REMOVAL_COUNT && missingCount / existingCount > MAJOR_REMOVAL_RATIO;
}
