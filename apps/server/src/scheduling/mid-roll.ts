import { TimelineMaterializationLimitError } from './limits.js';
import { planFiller } from './filler-plan.js';
import type { FillerSettings } from '@moirai/shared';
import { MAX_TIMELINE_SEGMENTS, MAX_MID_ROLL_POINTS, matchesMidRollPredicate, type ResolvedMidRollConfig, type SchedulableMedia,
	type SelectionStateRecord } from '@moirai/shared';
import { addIssue, type SelectionContext } from './selection.js';
import type { RecordedTimelineIssue } from './timeline-issues.js';

/** One source span and only the cursor changes caused by this span's selection. */
export interface AiringSpan {
	media: SchedulableMedia;
	role: 'primary' | 'filler';
	programId: string;
	programAncestry?: string[] | undefined;
	sequenceEntryPath?: string[] | undefined;
	sourceStartSeconds: number;
	sourceFinishSeconds: number;
	truncated: boolean;
	stateDelta: SelectionStateRecord[];
}

/** Speculative expansion discarded on fit rejection and committed only after acceptance. */
export interface AiringPlan {
	spans: AiringSpan[];
	durationSeconds: number;
	issues: RecordedTimelineIssue[];
}

/** Choose natural interior boundaries, or timed points when no usable chapters exist. */
function breakPoints(media: SchedulableMedia, interval: number): Array<{ point: number; title: string }> {
	const duration = media.durationSeconds!;
	const chapters = new Map<number, string>();
	for (const chapter of media.chapters ?? []) {
		const point = Math.round(chapter.finishSeconds * 1_000) / 1_000;
		if (Number.isFinite(point) && point > 0 && point < duration) {
			chapters.set(point, chapter.title);
		}
	}
	if (chapters.size > 0) {
		return [...chapters].sort(([left], [right]) => left - right).slice(0, MAX_MID_ROLL_POINTS)
			.map(([point, title]) => ({ point, title }));
	}

	const result: Array<{ point: number; title: string }> = [];
	for (let point = interval; point < duration && result.length < MAX_MID_ROLL_POINTS; point += interval) {
		result.push({ point, title: '' });
	}
	return result;
}

/** Expand one primary candidate with pre/mid/post stages using isolated filler state and diagnostics. */
export function planAiring(
	media: SchedulableMedia,
	primaryProgramId: string,
	config: ResolvedMidRollConfig | null,
	sourceState: Map<string, SelectionStateRecord>,
	sourceContext: SelectionContext,
	fillerConsumerKey: string,
	timeZone = 'UTC',
	rolls: { pre?: FillerSettings & { programId: string; consumerKey: string }; post?: FillerSettings & { programId: string; consumerKey: string }; seed?: string } = {},
): AiringPlan {
	const context: SelectionContext = { ...sourceContext, mediaDuration: undefined,
		issues: [], issueKeys: new Set(), issueIndex: new Map(), blockedPrograms: new Set(sourceContext.blockedPrograms) };
	let state = sourceState;
	const spans: AiringSpan[] = [];
	let durationSeconds = 0;
	const appendPrimary = (start: number, finish: number): void => {
		if (finish > start) {
			const previous = spans.at(-1);
			if (previous?.role === 'primary' && previous.sourceFinishSeconds === start) {
				previous.sourceFinishSeconds = finish;
				durationSeconds += finish - start;
				return;
			}
			if (spans.length >= MAX_TIMELINE_SEGMENTS) {
				throw new TimelineMaterializationLimitError(MAX_TIMELINE_SEGMENTS);
			}
			spans.push({ media, role: 'primary', programId: primaryProgramId, sourceStartSeconds: start,
				sourceFinishSeconds: finish, truncated: false, stateDelta: [] });
			durationSeconds += finish - start;
		}
	};
	const points = config ? breakPoints(media, config.fallbackIntervalSeconds) : [];
	if (config && (media.chapterLimitExceeded || (media.chapters?.length ?? 0) > MAX_MID_ROLL_POINTS
		|| (!media.chapters?.length && media.durationSeconds! / config.fallbackIntervalSeconds > MAX_MID_ROLL_POINTS + 1))) {
		addIssue(context, { code: 'mid-roll-points-limited', message: 'Mid-roll break points were limited to 256 for this item.',
			programId: primaryProgramId, mediaItemId: media.id });
	}

	// Evaluate guided conditions before selection so spacing follows points accepted by the whole rule.
	let matchedPoints = 0;
	let lastPoint = 0;
	const accepted: number[] = [];
	for (const [index, { point, title }] of points.entries()) {
		const match = matchesMidRollPredicate(config!.predicate, { total_points: points.length, matched_points: matchedPoints,
			total_duration: media.durationSeconds!, total_progress: point / media.durationSeconds!,
			remaining_duration: media.durationSeconds! - point, point, num: index + 1,
			last_mid_filler: point - lastPoint, title });
		if (match) {
			accepted.push(point);
			matchedPoints += 1;
			lastPoint = point;
		}
	}

	// Expand each stage at its actual clock position using isolated selection state.
	const insert = (settings: FillerSettings & { programId: string }, key: string, point: string): void => {
		const start = new Date(Date.parse(sourceContext.selectionStart) + Math.round(durationSeconds * 1_000)).toISOString();
		const result = planFiller(
			settings.programId,
			settings.budget,
			state,
			{ ...context, selectionStart: start },
			key,
			timeZone,
			`${rolls.seed ?? ''}:${key}:${sourceContext.selectionStart}:${media.id}:${point}`,
			Infinity,
			undefined,
			MAX_TIMELINE_SEGMENTS - spans.length,
		);
		spans.push(...result.spans);
		state = result.state;
		durationSeconds += result.durationSeconds;
		if (result.progress.remaining > 0) {
			addIssue(context, { code: 'mid-roll-shortfall', message: 'Filler could not supply the requested break budget. Content resumes immediately.',
				programId: settings.programId, mediaItemId: media.id,
				occurrence: { start, finish: null, boundaryOrigin: context.boundaryOrigin } });
		}
	};
	if (rolls.pre) {
		insert(rolls.pre, rolls.pre.consumerKey, 'pre');
	}
	let sourceStart = 0;
	for (const point of accepted) {
		appendPrimary(sourceStart, point);
		sourceStart = point;
		insert(config!, fillerConsumerKey, String(point));
	}
	appendPrimary(sourceStart, media.durationSeconds!);
	if (rolls.post) {
		insert(rolls.post, rolls.post.consumerKey, 'post');
	}
	return { spans, durationSeconds, issues: context.issues };
}
