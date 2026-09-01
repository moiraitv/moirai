/** Normalize a calendar-valid ISO date or date-time prefix to an exact release date. */
export function normalizedReleaseDate(value: unknown): string | null {
	if (typeof value !== 'string') {
		return null;
	}

	const match = value.trim().match(
		/^(\d{4})-(\d{2})-(\d{2})(?:[T ](?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,9})?)?(?:Z|[+-](?:[01]\d|2[0-3]):?[0-5]\d)?)?$/iu,
	);
	if (!match) {
		return null;
	}

	const normalized = `${match[1]}-${match[2]}-${match[3]}`;
	const parsed = new Date(`${normalized}T00:00:00.000Z`);
	return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().startsWith(normalized)
		? normalized
		: null;
}
