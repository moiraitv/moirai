import type { GuideEntry, GuideOccurrence, ScheduleTemplate, TimelineSegment } from '@moirai/shared';

/** Convert a concrete item into a presentation entry with a stable detail target. */
export function itemGuideEntry(segment: TimelineSegment): GuideEntry {
	return {
		id: segment.id, channelId: segment.channelId, kind: 'item',
		start: segment.start, finish: segment.finish, title: segment.title, description: '',
		programId: segment.programId, segmentId: segment.id, occurrenceId: null,
		role: segment.role, truncated: segment.truncated,
	};
}

/** Subtract sorted nonoverlapping display blocks, keeping original detail identities. */
function subtractBlocks(entries: GuideEntry[], blocks: GuideEntry[]): GuideEntry[] {
	const result: GuideEntry[] = [];
	let first = 0;
	for (const entry of entries) {
		while (first < blocks.length && Date.parse(blocks[first]!.finish) <= Date.parse(entry.start)) {
			first += 1;
		}
		let cursor = entry.start;
		for (let index = first; index < blocks.length && Date.parse(blocks[index]!.start) < Date.parse(entry.finish); index += 1) {
			const block = blocks[index]!;
			if (Date.parse(block.start) > Date.parse(cursor)) {
				result.push({ ...entry, start: cursor, finish: block.start });
			}
			if (Date.parse(block.finish) > Date.parse(cursor)) {
				cursor = block.finish;
			}
		}
		if (Date.parse(cursor) < Date.parse(entry.finish)) {
			result.push({ ...entry, start: cursor });
		}
	}
	return result;
}

/** Give the later-starting scheduled block ownership when DST conversion overlaps clock intervals. */
function normalizeScheduledBlocks(blocks: GuideEntry[]): GuideEntry[] {
	return blocks.map((block, index) => {
		const next = blocks[index + 1];
		return next && Date.parse(next.start) < Date.parse(block.finish) ? { ...block, finish: next.start } : block;
	}).filter((block) => Date.parse(block.start) < Date.parse(block.finish));
}

/** Project committed slots into guide-only blocks, with hard boundaries taking precedence. */
export function projectGuideEntries(
	channelId: string,
	segments: TimelineSegment[],
	occurrences: GuideOccurrence[],
	templates: ScheduleTemplate[],
	rangeStart: string,
	rangeEnd: string,
	programNames: ReadonlyMap<string, string> = new Map(),
): GuideEntry[] {
	const settings = new Map(templates.flatMap((template) => template.slots.map((slot) =>
		[`${template.id}/${slot.id}`, slot.guide] as const)));
	const scheduled: GuideEntry[] = [];
	const drift: GuideEntry[] = [];
	for (const occurrence of occurrences) {
		const guide = settings.get(`${occurrence.templateId}/${occurrence.slotId}`);
		if (guide?.mode !== 'block') {
			continue;
		}

		const start = guide.boundary === 'scheduled' ? occurrence.start : occurrence.actualStart;
		const finish = guide.boundary === 'scheduled' ? occurrence.finish : occurrence.actualFinish;
		if (!start || !finish || Date.parse(start) >= Date.parse(finish) || Date.parse(start) >= Date.parse(rangeEnd) || Date.parse(finish) <= Date.parse(rangeStart)) {
			continue;
		}

		(guide.boundary === 'scheduled' ? scheduled : drift).push({
			id: `slot-${occurrence.id}`, channelId, kind: 'block',
			start: Date.parse(start) < Date.parse(rangeStart) ? rangeStart : start, finish: Date.parse(finish) > Date.parse(rangeEnd) ? rangeEnd : finish,
			title: guide.title.trim() || (occurrence.programId ? programNames.get(occurrence.programId) ?? 'Missing program' : 'No programming'), description: guide.description, programId: occurrence.programId,
			segmentId: null, occurrenceId: occurrence.id, role: 'primary', truncated: false,
		});
	}
	scheduled.sort((left, right) => Date.parse(left.start) - Date.parse(right.start));
	drift.sort((left, right) => Date.parse(left.start) - Date.parse(right.start));
	const normalized = normalizeScheduledBlocks(scheduled);
	const blocks = [...normalized, ...subtractBlocks(drift, normalized)]
		.sort((left, right) => Date.parse(left.start) - Date.parse(right.start));
	const items = segments.map(itemGuideEntry).sort((left, right) => Date.parse(left.start) - Date.parse(right.start));
	return [...blocks, ...subtractBlocks(items, blocks)]
		.sort((left, right) => Date.parse(left.start) - Date.parse(right.start))
		.map((entry) => ({ ...entry, id: `${entry.id}/${entry.start}/${entry.finish}` }));
}
