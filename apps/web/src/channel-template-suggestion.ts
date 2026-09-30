import { catalogSortTitle, type ScheduleTemplate, type SchedulingProgram } from '@moirai/shared';

/** Maximum relative edit distance considered a close spelling match. */
const CLOSE_NAME_DISTANCE = 0.2;

/** Named resource eligible for a channel-name suggestion. */
type NamedResource = Pick<ScheduleTemplate | SchedulingProgram, 'id' | 'name'>;

/** Best name match and whether it is strong enough to preselect over another resource type. */
interface NameSuggestion {
	id: string;
	suitable: boolean;
}

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

/** Rank exact names, full phrases, then spelling similarity while keeping catalog ties stable. */
function bestNameSuggestion(
	channelName: string,
	resources: readonly NamedResource[],
): NameSuggestion | undefined {
	const channel = normalizedName(channelName);
	let selected = resources[0]?.id;
	if (!selected) {
		return undefined;
	}
	if (!channel) {
		return { id: selected, suitable: false };
	}

	let bestScore = Infinity;
	let suitable = false;
	for (const resource of resources) {
		const name = normalizedName(resource.name);
		if (name === channel) {
			return { id: resource.id, suitable: true };
		}

		const containsChannel = ` ${name} `.includes(` ${channel} `);
		const distance = nameDistance(channel, name) / Math.max(channel.length, name.length);
		const score = (containsChannel ? 0 : 1) + distance;
		if (score < bestScore) {
			bestScore = score;
			selected = resource.id;
			suitable = containsChannel || distance <= CLOSE_NAME_DISTANCE;
		}
	}
	return { id: selected, suitable };
}

/** Suggest the closest saved template, including a fallback when all names are unrelated. */
export function suggestedChannelTemplateId(
	channelName: string,
	templates: readonly Pick<ScheduleTemplate, 'id' | 'name'>[],
): string | undefined {
	return bestNameSuggestion(channelName, templates)?.id;
}

/** Prefer a suitable template, then a suitable program, before falling back to a catalog choice. */
export function suggestedChannelAssignment(
	channelName: string,
	templates: readonly Pick<ScheduleTemplate, 'id' | 'name'>[],
	programs: readonly Pick<SchedulingProgram, 'id' | 'name'>[],
): { templateId: string | null; programId: string | null } {
	const template = bestNameSuggestion(channelName, templates);
	const program = bestNameSuggestion(channelName, programs);
	if (template?.suitable || (template && !program?.suitable)) {
		return { templateId: template.id, programId: null };
	}
	return { templateId: null, programId: program?.id ?? null };
}
