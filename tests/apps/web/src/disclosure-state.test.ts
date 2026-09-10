import { afterEach, describe, expect, it, vi } from 'vitest';
import { effectScope } from 'vue';
import { useDisclosureState } from '@web/disclosure-state';

afterEach(() => vi.unstubAllGlobals());

describe('disclosure preferences', () => {
	it('restores both states independently across instances', () => {
		const values = new Map<string, string>();
		vi.stubGlobal('localStorage', {
			getItem: (key: string) => values.get(key) ?? null,
			setItem: (key: string, value: string) => values.set(key, value),
		});
		const scope = effectScope();
		scope.run(() => {
			const first = useDisclosureState('first', true);
			const second = useDisclosureState('second');
			expect(first.value).toBe(true);
			expect(second.value).toBe(false);
			first.value = false;
			second.value = true;
			expect(useDisclosureState('first', true).value).toBe(false);
			expect(useDisclosureState('second').value).toBe(true);
		});
		scope.stop();
	});

	it('uses defaults for invalid storage and works when storage is blocked', () => {
		vi.stubGlobal('localStorage', {
			getItem: () => 'invalid',
			setItem: () => {
				throw new Error('blocked'); 
			},
		});
		const scope = effectScope();
		scope.run(() => {
			const open = useDisclosureState('test', true);
			expect(open.value).toBe(true);
			expect(() => {
				open.value = false; 
			}).not.toThrow();
			vi.stubGlobal('localStorage', { getItem: () => {
				throw new Error('blocked'); 
			} });
			expect(useDisclosureState('test').value).toBe(false);
		});
		scope.stop();
	});
});
