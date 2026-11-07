import { prepareGraphicsContexts } from './context.js';
import type { Repository } from '../repository/index.js';
import type { Channel, GraphicsAssignment, GraphicsContext, TimelineSegment } from '@moirai/shared';
import type { GraphicsAssignments, GraphicsRepository, PreparedGraphicsPresets } from '../repository/graphics.js';

/** Optional graphics work yields quickly when a viewer is waiting. */
export const graphicsPreparationBudget = { live: 120, background: 2_000 };

/** One active preset and whether its text is eligible on the current item. */
export interface ResolvedGraphicsPreset {
	id: string;
	text: boolean;
}

/** Committed metadata and ordered graphics needed by the playout adapter. */
export type GraphicsSegment = Pick<TimelineSegment, 'id' | 'airing' | 'role' | 'title' | 'subtitle' | 'start' | 'finish' | 'fillerPresetId' | 'mediaItemId'> & {
	presets?: ResolvedGraphicsPreset[];
};

/** Keep primary items, authored rolls, and indexed filler eligible for graphics. */
export function isGraphicsEligible(segment: Pick<GraphicsSegment, 'role' | 'airing' | 'fillerPresetId' | 'mediaItemId'>): boolean {
	return segment.role === 'primary'
		|| (segment.role === 'filler' && Boolean(segment.airing || segment.fillerPresetId || segment.mediaItemId));
}

/** Resolve a stack for one committed item using its actual selection and placement. */
export function resolveGraphicsPresets(channel: Channel, segment: TimelineSegment, assignments: GraphicsAssignments): ResolvedGraphicsPreset[] {
	const primary = segment.role === 'primary';
	let stack: ResolvedGraphicsPreset[] = channel.graphicsPresetId ? [{ id: channel.graphicsPresetId, text: primary }] : [];
	const apply = (assignment: GraphicsAssignment | undefined, text: boolean): void => {
		if (!assignment || assignment.mode === 'inherit') {
			return;
		}
		if (assignment.mode === 'off') {
			stack = [];
			return;
		}
		stack = assignment.mode === 'replace' ? [] : stack.filter(preset => preset.id !== assignment.presetId);
		stack.push({ id: assignment.presetId, text });
	};

	apply(assignments.get(`schedule:${channel.id}`), primary);
	apply(assignments.get(`template:${segment.templateId}`), primary);
	const slot = assignments.get(`slot:${segment.slotId}`);
	if (!primary) {
		apply(slot, false);
	}
	const ancestry = segment.programAncestry?.length ? segment.programAncestry : segment.programId ? [segment.programId] : [];
	for (const id of ancestry) {
		apply(assignments.get(`program:${id}`), true);
	}
	if (primary) {
		apply(slot, true);
	}
	else if (segment.fillerPresetId) {
		apply(assignments.get(`filler:${segment.fillerPresetId}`), true);
	}
	return stack;
}

/** Keep eligible context even if only some items have assigned graphics. */
export function selectGraphicsSegments(segments: TimelineSegment[], channel?: Channel, assignments?: GraphicsAssignments): GraphicsSegment[] {
	return segments
		.filter(isGraphicsEligible)
		.map(segment => {
			const { id, airing, role, title, subtitle, start, finish, fillerPresetId, mediaItemId } = segment;
			return { id, airing, role, title, subtitle, start, finish, fillerPresetId, mediaItemId,
				...(channel && assignments ? { presets: resolveGraphicsPresets(channel, segment, assignments) } : {}) };
		});
}

/** Resolve the assignments used for a physical item, including legacy channel defaults. */
export function graphicsAssignmentsForSegment(channel: Channel, segment: GraphicsSegment): ResolvedGraphicsPreset[] {
	return segment.presets ?? (channel.graphicsPresetId ? [{ id: channel.graphicsPresetId, text: segment.role === 'primary' }] : []);
}

/** Collect the distinct preset IDs required by a committed window. */
export function graphicsPresetIds(channel: Channel, segments: GraphicsSegment[]): Set<string> {
	return new Set(segments.flatMap(segment => graphicsAssignmentsForSegment(channel, segment).map(preset => preset.id)));
}

/** Optional graphics data transferred from the preparation worker with the compact guide. */
export interface PlayoutGraphics {
	segments: GraphicsSegment[];
	presets: PreparedGraphicsPresets;
	contexts?: Map<string, GraphicsContext>;
}

/** Hydrate the committed window once and allow video publication if preset data is unavailable. */
export function preparePlayoutGraphics(repository: GraphicsRepository, channel: Channel, committed: TimelineSegment[]): PlayoutGraphics | undefined {
	const assignments = repository.assignments({ channelId: channel.id, segments: committed });
	if (!channel.graphicsPresetId && !assignments.size) {
		return undefined;
	}
	const segments = selectGraphicsSegments(committed, channel, assignments);
	const ids = graphicsPresetIds(channel, segments);
	if (!ids.size) {
		return undefined;
	}
	try {
		return { segments, presets: repository.preparePresets(ids) };
	}
	catch {
		return { segments, presets: new Map() };
	}
}


/** Hydrate Liquid metadata only for items whose assigned overlays can render text. */
export async function preparePlayoutGraphicsLabels(
	repository: Repository,
	channel: Channel,
	committed: TimelineSegment[],
	timeZone: string,
	publicUrl: string,
	budgetMs: number | (() => number),
): Promise<PlayoutGraphics | undefined> {
	const graphics = preparePlayoutGraphics(repository.graphics, channel, committed);
	if (!graphics) {
		return undefined;
	}

	const now = Date.now();
	const textPresets = new Set([...graphics.presets].flatMap(([id, preset]) =>
		preset.document.layers.some(layer => layer.kind === 'text') ? [id] : []));
	const targetIds = new Set(graphics.segments.filter(segment => Date.parse(segment.finish) > now
		&& graphicsAssignmentsForSegment(channel, segment).some(preset => preset.text && textPresets.has(preset.id)))
		.map(segment => segment.id));
	if (!targetIds.size) {
		return graphics;
	}

	const started = performance.now();
	try {
		graphics.contexts = await prepareGraphicsContexts(
			repository,
			channel,
			committed,
			committed.filter(segment => targetIds.has(segment.id)),
			timeZone,
			publicUrl,
			() => (typeof budgetMs === 'number' ? budgetMs : budgetMs()) - (performance.now() - started),
		);
	}
	catch {
		graphics.contexts = new Map();
	}
	return graphics;
}
