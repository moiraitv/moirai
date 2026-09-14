import type { MediaSourceMatch } from '@moirai/shared';

/** Explain metadata matches while omitting the title already visible on the card. */
export function mediaSearchMatchText(matches: MediaSourceMatch[] = []): string {
	return matches
		.filter(match => match.field !== 'title')
		.map(match => `${match.field.charAt(0).toUpperCase() + match.field.slice(1)} · ${match.label}`)
		.join(' · ');
}
