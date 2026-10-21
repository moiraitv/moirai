import { createHash } from 'node:crypto';

/**
 * Preserve the probe-v11 identity format used by existing ignore decisions.
 * This marker is independent of probe changes and must remain stable.
 */
const FILE_IDENTITY_FORMAT = 11;

/**
 * Identify physical inputs by size and modification time within their library/path scope.
 * Exclude probe versions and remount-sensitive device/inode numbers so software updates
 * and network-share remounts preserve decisions about unchanged files.
 */
export function mediaFileFingerprint(info: { size: number | bigint; mtimeMs: number | bigint }): string {
	return createHash('sha256')
		.update([FILE_IDENTITY_FORMAT, String(info.size), String(info.mtimeMs)].join(':'))
		.digest('hex');
}
