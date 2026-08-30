import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUuid } from '@web/random-uuid';

describe('random UUID', () => {
	afterEach(() => vi.unstubAllGlobals());

	it('generates a UUID v4 when randomUUID is unavailable', () => {
		vi.stubGlobal('crypto', {
			getRandomValues: (bytes: Uint8Array) => {
				bytes.set(Array.from({ length: 16 }, (_, index) => index));
				return bytes;
			},
		});

		expect(randomUuid()).toBe('00010203-0405-4607-8809-0a0b0c0d0e0f');
	});
});
