import { catalogSortTitle } from '@moirai/shared';

/** Preserve the catalog's English, case-insensitive ordering without rebuilding collators. */
const nameCollator = new Intl.Collator('en-US', { sensitivity: 'base' });

/** Normalize each authored name once and return a sorted copy retaining resource identity. */
export function orderCatalogNames<T extends { name: string }>(values: readonly T[]): T[] {
	return values.map(value => ({ value, key: catalogSortTitle(value.name) }))
		.sort((left, right) => nameCollator.compare(left.key, right.key))
		.map(entry => entry.value);
}
