/** A searchable language record with all supported comparison aliases. */
export interface SubtitleLanguage {
	name: string;
	code: string;
	aliases: string[];
}

/** Maximum language choices rendered at once, keeping the combobox lightweight. */
export const SUBTITLE_LANGUAGE_RESULT_LIMIT = 50;
/** Share the lazily imported ISO inventory between mounted subtitle editors. */
let inventory: Promise<SubtitleLanguage[]> | undefined;

/** Load the existing ISO data package only when a specific language is being edited. */
export function loadSubtitleLanguages(): Promise<SubtitleLanguage[]> {
	inventory ??= import('iso-639-3').then(({ iso6393 }) => iso6393.map(language => ({
		name: language.name,
		code: language.iso6391 ?? language.iso6393,
		aliases: [...new Set([language.iso6391, language.iso6393, language.iso6392B, language.iso6392T].filter((code): code is string => Boolean(code)))],
	})).sort((left, right) => left.name.localeCompare(right.name, 'en'))).catch(error => {
		inventory = undefined;
		throw error;
	});
	return inventory;
}

/** Require a choice for name/code collisions while retaining unchanged saved codes. */
export function resolveSubtitleLanguage(value: string, languages: SubtitleLanguage[], preserveCode = false): string | null {
	const text = value.trim().toLowerCase();
	const named = languages.filter(language => language.name.toLowerCase() === text);
	if (/^[a-z]{2,3}$/.test(text)) {
		const coded = languages.find(language => language.aliases.includes(text));
		if (!preserveCode && named.some(language => language !== coded)) {
			return null;
		}
		return text;
	}

	const label = languages.find(language => `${language.name} (${language.code})`.toLowerCase() === text);
	if (label) {
		return label.code;
	}
	return named.length === 1 ? named[0]!.code : null;
}

/** Search names and aliases, offering common two-letter languages when the query is empty. */
export function searchSubtitleLanguages(languages: SubtitleLanguage[], value: string): SubtitleLanguage[] {
	const query = value.trim().toLowerCase();
	const selected = languages.find(language => `${language.name} (${language.code})`.toLowerCase() === query);
	if (selected) {
		return [selected];
	}

	const exact = query ? languages.filter(language => language.name.toLowerCase() === query || language.aliases.includes(query)) : [];
	const matches = languages.filter(language => !exact.includes(language) && (query
		? language.name.toLowerCase().includes(query) || language.aliases.some(code => code.includes(query))
		: language.code.length === 2));
	return [...exact, ...matches].slice(0, SUBTITLE_LANGUAGE_RESULT_LIMIT);
}
