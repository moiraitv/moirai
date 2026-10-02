import { expect, it } from 'vitest';
import { InputFingerprintContext } from '@server/scheduling/input-fingerprint.js';
import { stableJsonFingerprint } from '@server/stable-json.js';

it('retains canonical fingerprint bytes with shared objects, array order and optional values', () => {
	const shared = { title: 'A "title"', missing: undefined, nested: { z: null, a: [true, false, 1.5] } };
	const values = [{ first: shared, second: shared }, [shared, shared], { Z: 1, a: 2, 'ä': 3 }, null, []];
	const context = new InputFingerprintContext();
	for (const value of values) {
		expect(context.fingerprint(value)).toBe(stableJsonFingerprint(value));
		expect(context.fingerprint(value)).toBe(stableJsonFingerprint(value));
	}
});

it('retains rejection of a non-JSON root value', () => {
	expect(() => new InputFingerprintContext().fingerprint(undefined)).toThrow(TypeError);
});

it('reuses identical catalog scopes across channels without inspecting media again', () => {
	let reads = 0;
	const media = {
		id: 'item', groupId: null, availability: 'available',
		get libraryId() {
			reads += 1;
			return 'library';
		},
	};
	const catalog = { media: [media], groupParents: {}, groupTitles: {}, libraryNames: { library: 'Movies' } } as unknown as import('@moirai/shared').SchedulingCatalog;
	const context = new InputFingerprintContext();
	const first = context.scope(catalog, new Set(['library']), new Set(), new Set());
	const inspected = reads;
	expect(inspected).toBeGreaterThan(0);
	expect(context.scope(catalog, new Set(['library']), new Set(), new Set())).toBe(first);
	expect(reads).toBe(inspected);
	expect(context.scope({ ...catalog }, new Set(['library']), new Set(), new Set())).not.toBe(first);
	expect(reads).toBeGreaterThan(inspected);
});
