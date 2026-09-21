import { expect, it } from 'vitest';
import { catalogSortTitle } from '@moirai/shared';
import { orderCatalogNames } from '@web/catalog-name-order';

it('preserves article-normalized, case-insensitive catalog order and resource identity', () => {
	const values = ['The Zebra', 'A Bear', 'bear', 'Écho', 'echo', 'An Apple', 'Program 10', 'Program 2']
		.map((name, id) => ({ name, id }));
	const expected = [...values].sort((left, right) => catalogSortTitle(left.name)
		.localeCompare(catalogSortTitle(right.name), 'en-US', { sensitivity: 'base' }));
	const result = orderCatalogNames(values);
	expect(result).toEqual(expected);
	expect(result[0]).toBe(expected[0]);
	expect(values[0]?.name).toBe('The Zebra');
});
