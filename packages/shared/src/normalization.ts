/** Fold a user-visible identifier into a stable comparison key. */
export function canonicalIdentityKey(value: string): string {
	return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');
}

/** Fold a channel number into its case-insensitive filesystem identity. */
export function canonicalChannelNumberKey(value: string): string {
	return value.trim().toLowerCase();
}

/** Canonical genre key used by catalog indexing and scheduling queries. */
export function canonicalGenreKey(value: string): string {
	const normalized = canonicalIdentityKey(value)
		.replace(/[-_/]+/g, ' ')
		.replace(/\s+/g, ' ');
	const aliases: Record<string, string> = {
		sport: 'sports',
		sports: 'sports',
		'sci fi': 'science-fiction',
		scifi: 'science-fiction',
		'science fiction': 'science-fiction',
		'film noir': 'film-noir',
	};
	return aliases[normalized]
		?? normalized.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/** Deduplicate and sort values whose order has no meaning. */
export function canonicalStringSet(values: string[], keyFor = canonicalIdentityKey): string[] {
	const valuesByKey = new Map<string, string>();
	for (const rawValue of values) {
		const value = rawValue.normalize('NFKC').trim().replace(/\s+/g, ' ');
		const key = keyFor(value);
		if (key && !valuesByKey.has(key)) {
			valuesByKey.set(key, key);
		}
	}
	return [...valuesByKey.values()].sort((left, right) => left.localeCompare(right, 'en-US'));
}

/** Deduplicate and sort numeric values whose order has no meaning. */
export function canonicalNumberSet(values: number[]): number[] {
	return [...new Set(values)].sort((left, right) => left - right);
}
