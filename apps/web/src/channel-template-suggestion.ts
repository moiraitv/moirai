import { catalogSortTitle, type ScheduleTemplate } from '@moirai/shared';

/** Compare names without leading articles, punctuation, accents, or letter case. */
function normalizedName(value: string): string {
	return catalogSortTitle(value).normalize('NFKD').replace(/\p{Diacritic}/gu, '').toLocaleLowerCase('en-US');
}

/** Count character insertions, deletions, and substitutions using one row of working storage. */
function nameDistance(left: string, right: string): number {
	const row = Array.from({ length: right.length + 1 }, (_, index) => index);
	for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
		let diagonal = row[0]!;
		row[0] = leftIndex;
		for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
			const previous = row[rightIndex]!;
			row[rightIndex] = Math.min(
				previous + 1,
				row[rightIndex - 1]! + 1,
				diagonal + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
			);
			diagonal = previous;
		}
	}
	return row[right.length]!;
}

/** Prefer exact names, then a full channel-name phrase, then relative spelling similarity; keep ties stable. */
export function suggestedChannelTemplateId(
	channelName: string,
	templates: readonly Pick<ScheduleTemplate, 'id' | 'name'>[],
): string | undefined {
	const channel = normalizedName(channelName);
	let selected = templates[0]?.id;
	if (!channel) {
		return selected;
	}

	let bestScore = Infinity;
	for (const template of templates) {
		const name = normalizedName(template.name);
		if (name === channel) {
			return template.id;
		}

		const containsChannel = ` ${name} `.includes(` ${channel} `);
		const distance = nameDistance(channel, name) / Math.max(channel.length, name.length);
		const score = (containsChannel ? 0 : 1) + distance;
		if (score < bestScore) {
			bestScore = score;
			selected = template.id;
		}
	}
	return selected;
}
