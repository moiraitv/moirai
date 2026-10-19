import type { BackupInfo } from '@moirai/shared';

/** Label the categories whose archive retention policies differ. */
export function backupCategory(kind: BackupInfo['kind']): string {
	return { automatic: 'Automatic', manual: 'Manual', 'pre-restore': 'Pre-restore recovery', upgrade: 'Upgrade recovery' }[kind];
}
/** Display archive timestamps in the viewer's locale. */
export function backupCreatedDate(value: string): string {
	return new Date(value).toLocaleString();
}
/** Display archive sizes using binary units. */
export function backupSize(bytes: number): string {
	return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GiB` : bytes < 1024 ** 2 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
}
