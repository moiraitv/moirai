/** Preserve an authored key or remove punctuation and a leading article from a fallback sort key. */
export function catalogSortTitle(title: string, authoredSortTitle?: string | null): string {
	if (authoredSortTitle !== undefined && authoredSortTitle !== null) {
		return authoredSortTitle;
	}

	const normalized = title
		.replace(/[\p{Punctuation}\p{Symbol}]+/gu, '')
		.trim()
		.replace(/\s+/g, ' ');
	const match = normalized.match(/^(A|An|The)\s+(.+)$/iu);
	return match?.[2] ?? normalized;
}
