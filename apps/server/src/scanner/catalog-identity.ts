import { createHash } from 'node:crypto';

/** Derive a stable catalog UUID from a library namespace and source identity. */
export function deterministicId(namespace: string, key: string): string {
	const hex = createHash('sha256').update(`${namespace}:${key}`).digest('hex');
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
