/** Safe storage diagnostics retain the cause and remedy without exposing filesystem paths. */
const storageMessages: Record<string, string> = {
	EACCES: 'Permission denied accessing storage. Check the mounted volume’s ownership and permissions for the container user.',
	EPERM: 'Permission denied accessing storage. Check the mounted volume’s ownership and permissions for the container user.',
	EROFS: 'Storage is read-only. Mount the volume with write access.',
	ENOSPC: 'Storage is full. Free disk space on the volume and try again.',
	EEXIST: 'A storage path already exists. Check that the configured directory is a folder and the destination file can be created.',
	ENOTDIR: 'The storage location is not a directory. Check the configured path and volume mount.',
	ENOENT: 'The required storage location is missing. Check the configured path and volume mount.',
	EIO: 'A storage read or write failed. Check the volume and disk health.',
	SQLITE_BUSY: 'The database is busy. Try again shortly.',
	SQLITE_CANTOPEN: 'The database cannot be opened. Check storage availability and permissions.',
	SQLITE_FULL: 'Database storage is full. Free disk space and try again.',
	SQLITE_IOERR: 'A database read or write failed. Check the volume and disk health.',
	SQLITE_READONLY: 'Database storage is read-only. Check the volume mount and permissions.',
};

/** Return an actionable diagnostic only for recognized storage error codes. */
export function storageFailureMessage(error: unknown): string | null {
	const code = (error as { code?: unknown } | null)?.code;
	return typeof code === 'string' && Object.hasOwn(storageMessages, code) ? storageMessages[code]! : null;
}
