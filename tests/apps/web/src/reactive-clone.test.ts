import { reactive } from 'vue';
import { describe, expect, it } from 'vitest';
import { cloneContractValue } from '@web/reactive-clone';

describe('cloneContractValue', () => {
	it('clones nested API data after Vue has wrapped it in a reactive proxy', () => {
		const nestedProxy = reactive([{ id: 'slot', programId: null }]);
		const source = reactive({
			id: 'template',
			slots: nestedProxy,
		});

		const clone = cloneContractValue(source);

		expect(clone).toEqual(source);
		expect(clone).not.toBe(source);
		expect(clone.slots).not.toBe(source.slots);
	});
});
