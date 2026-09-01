import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { stableJson, stableJsonFingerprint } from '@server/stable-json.js';

describe('stable JSON', () => {
	it('orders object keys recursively while preserving array order', () => {
		const value = {
			zebra: [{ second: 2, first: 1 }],
			alpha: true,
		};

		expect(stableJson(value)).toBe('{"alpha":true,"zebra":[{"first":1,"second":2}]}');
	});

	it('gives equivalent objects the same fingerprint', () => {
		const left = { second: { beta: 2, alpha: 1 }, first: true };
		const right = { first: true, second: { alpha: 1, beta: 2 } };
		const expected = createHash('sha256').update(stableJson(left)).digest('hex');

		expect(stableJsonFingerprint(left)).toBe(expected);
		expect(stableJsonFingerprint(right)).toBe(expected);
	});
});
