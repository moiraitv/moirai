import { MAX_MID_ROLL_POINTS, matchesMidRollPredicate, legacyTailPresetId, type AnyFillerPreset, type FillerAssignment, type FillerBudget, type FillerConfig, type FillerKind, type SlotFillerAssignment } from '@moirai/shared';

/** Source duration used by the illustrative, chapterless movie. */
export const EXAMPLE_MOVIE_SECONDS = 137 * 60;
/** Playback stages offered by the combined assignment editor. */
export const FILLER_STAGES: Array<{ kind: FillerKind; label: string }> = [
	{ kind: 'pre-roll', label: 'Pre-Roll' }, { kind: 'mid-roll', label: 'Mid-Roll' },
	{ kind: 'post-roll', label: 'Post-Roll' }, { kind: 'tail', label: 'Tail Filler' },
];
/** Assignments before resolving optional slot inheritance and legacy tail presets. */
export type FillerAssignments = Partial<Record<FillerKind, FillerAssignment | FillerConfig | null | undefined>>;
/** Slot-local decisions, with the legacy tail policy retained when present. */
export type FillerOverrides = Partial<Record<FillerKind, SlotFillerAssignment | { mode: 'configured'; config: FillerConfig } | undefined>>;
/** One visual span, including inactive example gaps that do not add playback time. */
export interface FillerExampleSpan {
	kind: FillerKind | 'content';
	seconds: number;
	point: number;
	active: boolean;
}

/** Resolve overrides independently and normalize legacy tail assignments for preset lookup. */
export function effectiveFillerAssignments(defaults: FillerAssignments, overrides?: FillerOverrides): FillerAssignments {
	return Object.fromEntries(FILLER_STAGES.map(({ kind }) => {
		const override = overrides?.[kind];
		const assignment = override?.mode === 'disabled' ? null : override?.mode === 'configured' ? override.config : defaults[kind];
		return [kind, assignment && 'policy' in assignment ? { ...assignment, presetId: assignment.presetId ?? legacyTailPresetId(assignment.policy) } : assignment];
	}));
}

/** Illustrate budgets at a 20:03 start, with 30-second items and midpoint random quantities. */
function exampleBudgetSeconds(budget: FillerBudget, elapsed: number): number {
	switch (budget.type) {
		case 'duration': return budget.seconds;
		case 'count': return budget.count * 30;
		case 'random-count': return Math.floor((budget.minimum + budget.maximum) / 2) * 30;
		case 'pad': {
			const interval = budget.minutes * 60;
			return (interval - (180 + elapsed) % interval) % interval;
		}
		case 'remaining': return (1800 - (180 + elapsed) % 1800) % 1800;
	}
}

/** Evaluate real timed break rules while keeping unconfigured stages visible as example gaps. */
export function simulateFiller(assignments: FillerAssignments, presets: AnyFillerPreset[]): FillerExampleSpan[] {
	const spans: FillerExampleSpan[] = [];
	let elapsed = 0;
	const byId = new Map(presets.map(preset => [preset.id, preset]));
	const presetFor = (kind: FillerKind): AnyFillerPreset | undefined => {
		const preset = byId.get(assignments[kind]?.presetId ?? '');
		return preset?.kind === kind ? preset : undefined;
	};
	const insert = (kind: FillerKind, point: number): void => {
		const preset = presetFor(kind);
		const active = !!assignments[kind];
		const seconds = preset ? exampleBudgetSeconds(preset.budget, elapsed) : 120;
		spans.push({ kind, seconds, point, active });
		if (active) {
			elapsed += seconds;
		}
	};
	const mid = presetFor('mid-roll');
	const points: number[] = [];
	if (mid?.kind === 'mid-roll') {
		const candidates: number[] = [];
		for (let point = mid.fallbackIntervalSeconds; point < EXAMPLE_MOVIE_SECONDS && candidates.length < MAX_MID_ROLL_POINTS; point += mid.fallbackIntervalSeconds) {
			candidates.push(point);
		}
		let lastPoint = 0;
		for (const [index, point] of candidates.entries()) {
			if (matchesMidRollPredicate(mid.predicate, { total_points: candidates.length, matched_points: points.length,
				total_duration: EXAMPLE_MOVIE_SECONDS, total_progress: point / EXAMPLE_MOVIE_SECONDS,
				remaining_duration: EXAMPLE_MOVIE_SECONDS - point, point, num: index + 1, last_mid_filler: point - lastPoint, title: '' })) {
				points.push(point);
				lastPoint = point;
			}
		}
	}
	else {
		points.push(EXAMPLE_MOVIE_SECONDS / 2);
	}

	// Keep the content's source clock separate from the expanded playback clock.
	insert('pre-roll', 0);
	let sourceStart = 0;
	for (const point of [...points, EXAMPLE_MOVIE_SECONDS]) {
		spans.push({ kind: 'content', seconds: point - sourceStart, point: sourceStart, active: true });
		elapsed += point - sourceStart;
		if (point < EXAMPLE_MOVIE_SECONDS) {
			insert('mid-roll', point);
		}
		sourceStart = point;
	}
	insert('post-roll', EXAMPLE_MOVIE_SECONDS);
	insert('tail', EXAMPLE_MOVIE_SECONDS);
	return spans;
}
