import { describe, expect, it } from 'vitest';
import { countLabel } from '@web/count-label.js';

describe('count labels', () => {
	it('uses singular nouns only for exactly one item', () => {
		expect(countLabel(0, 'slot')).toBe('0 slots');
		expect(countLabel(1, 'slot')).toBe('1 slot');
		expect(countLabel(2, 'slot')).toBe('2 slots');
		expect(countLabel(1, 'person', 'people')).toBe('1 person');
		expect(countLabel(2, 'person', 'people')).toBe('2 people');
	});
});
