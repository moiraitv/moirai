import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isPathWithinRoot } from '../../../../../apps/server/src/media/path-boundary.js';

describe('path boundary', () => {
	const root = path.resolve(path.sep, 'srv', 'moirai');

	it('accepts the root and its descendants', () => {
		expect(isPathWithinRoot(root, root)).toBe(true);
		expect(isPathWithinRoot(root, path.join(root, 'channels', '601.1'))).toBe(true);
	});

	it('rejects sibling paths with the same text prefix', () => {
		expect(isPathWithinRoot(root, `${root}-backup`)).toBe(false);
		expect(isPathWithinRoot(root, path.resolve(root, '..', 'outside'))).toBe(false);
	});
});
