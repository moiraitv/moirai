import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { mediaFileFingerprint } from '@server/media/file-fingerprint.js';

it('preserves probe-v11 fingerprint bytes used by persisted decisions', () => {
	const legacy = createHash('sha256').update('11:500:1000').digest('hex');
	expect(mediaFileFingerprint({ size: 500, mtimeMs: 1_000 })).toBe(legacy);
	expect(mediaFileFingerprint({ size: 500n, mtimeMs: 1_000n })).toBe(legacy);
});

it('ignores remount identities while detecting size and modification-time changes', () => {
	const before = { size: 500, mtimeMs: 1_000, dev: 1, ino: 2 };
	const remounted = { ...before, dev: 3, ino: 4 };
	expect(mediaFileFingerprint(remounted)).toBe(mediaFileFingerprint(before));
	expect(mediaFileFingerprint({ ...before, size: 501 })).not.toBe(mediaFileFingerprint(before));
	expect(mediaFileFingerprint({ ...before, mtimeMs: 2_000 })).not.toBe(mediaFileFingerprint(before));
});
