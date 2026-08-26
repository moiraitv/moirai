import { describe, expect, it } from 'vitest';

import { useDismissibleHelp } from '@web/dismissible-help';

function memoryStorage(initialValue?: string): Storage {
	const values = new Map<string, string>();
	if (initialValue) {
		values.set('help-key', initialValue);
	}
	return {
		get length() {
			return values.size;
		},
		clear: () => values.clear(),
		getItem: (key) => values.get(key) ?? null,
		key: (index) => [...values.keys()][index] ?? null,
		removeItem: (key) => {
			values.delete(key);
		},
		setItem: (key, value) => values.set(key, value),
	};
}

describe('dismissible help state', () => {
	it('starts visible and persists dismissal until explicitly restored', () => {
		const storage = memoryStorage();
		const firstVisit = useDismissibleHelp('help-key', storage);

		expect(firstVisit.visible.value).toBe(true);
		firstVisit.dismiss();
		expect(firstVisit.visible.value).toBe(false);

		const returnVisit = useDismissibleHelp('help-key', storage);
		expect(returnVisit.visible.value).toBe(false);
		returnVisit.show();
		expect(useDismissibleHelp('help-key', storage).visible.value).toBe(true);
	});

	it('keeps working when preference storage throws', () => {
		const unavailableStorage = {
			getItem: () => {
				throw new Error('unavailable');
			},
			setItem: () => {
				throw new Error('unavailable');
			},
			removeItem: () => {
				throw new Error('unavailable');
			},
		};
		const state = useDismissibleHelp('help-key', unavailableStorage);

		expect(state.visible.value).toBe(true);
		state.dismiss();
		expect(state.visible.value).toBe(false);
		state.show();
		expect(state.visible.value).toBe(true);
	});
});
