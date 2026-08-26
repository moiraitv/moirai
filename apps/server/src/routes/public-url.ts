/** Resolve a public URL and replace its cache-version query parameter. */
export function versionedPublicUrl(
	publicUrl: string,
	value: string | null,
	version: string,
): string | null {
	if (!value) {
		return null;
	}

	const url = new URL(value, `${publicUrl.replace(/\/+$/u, '')}/`);
	url.searchParams.set('v', version);

	return url.toString();
}
