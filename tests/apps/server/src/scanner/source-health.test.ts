import { describe, expect, it } from 'vitest';
import { MAJOR_REMOVAL_COUNT, MAJOR_REMOVAL_RATIO } from '@moirai/shared';
import { isMajorRemoval, sourceIdentityHash, sourceManifest } from '@server/scanner/source-health.js';

describe('source reconciliation health', () => {
	it('classifies only drops above both documented major-removal boundaries', () => {
		const existing = 100;
		const atRatio = Math.floor(existing * MAJOR_REMOVAL_RATIO);
		expect(isMajorRemoval(existing, existing - atRatio, atRatio)).toBe(false);
		expect(
			isMajorRemoval(
				existing,
				existing - atRatio - 1,
				Math.max(MAJOR_REMOVAL_COUNT + 1, atRatio + 1),
			),
		).toBe(true);
	});

	it('always classifies an empty result from a populated source as major', () => {
		expect(isMajorRemoval(1, 0, 1)).toBe(true);
		expect(isMajorRemoval(0, 0, 0)).toBe(false);
	});

	it('stabilizes source locations across remounts and manifests across discovery order', () => {
		const identity = {
			sourceType: 'on-disk' as const,
			sourceKey: '/media',
			details: { canonicalRoot: '/media', device: '1', inode: '2' },
		};
		expect(sourceIdentityHash(identity)).toBe(
			sourceIdentityHash({
				...identity,
				details: { ...identity.details, device: '9', inode: '22' },
			}),
		);
		expect(sourceIdentityHash(identity)).not.toBe(
			sourceIdentityHash({ ...identity, sourceKey: '/replacement' }),
		);
		expect(sourceManifest(['b.mkv', 'a.mkv'])).toBe(sourceManifest(['a.mkv', 'b.mkv']));
	});
});
