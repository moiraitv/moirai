/** Explicit editor states retain the existing omitted/null/string preference contract. */
export type SubtitleRuleMode = 'inherit' | 'any' | 'specific';

/** Describe one rule without changing its authored spelling or inheritance. */
export function subtitleRuleMode(value: string | null | undefined, inherit: boolean): SubtitleRuleMode {
	return value === undefined && inherit ? 'inherit' : value == null ? 'any' : 'specific';
}
