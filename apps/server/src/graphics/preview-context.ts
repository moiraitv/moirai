import { Temporal } from '@js-temporal/polyfill';
import { emptyGraphicsContext, type Channel, type GraphicsPreviewContext, type TimelineSegment } from '@moirai/shared';
import type { Repository } from '../repository/index.js';
import { prepareGraphicsContexts } from './context.js';
import { graphicsPreparationBudget } from './segments.js';

/** Internal preview selection. Only the path-free preview context is returned to the browser. */
export interface GraphicsPreviewPosition {
	channel: Channel;
	at: number;
	segment: TimelineSegment | null;
	preview: GraphicsPreviewContext;
}

/** Resolve both preview modes against the same committed reference and elapsed position. */
export async function resolveGraphicsPreviewPosition(
	repository: Repository,
	channel: Channel,
	elapsedMs: number,
	timeZone: string,
	publicUrl: string,
	includeContext = true,
): Promise<GraphicsPreviewPosition> {
	const now = Temporal.Now.instant();
	const today = now.toZonedDateTimeISO(timeZone).toPlainDate();
	const start = today.subtract({ days: 1 }).toZonedDateTime(timeZone).toInstant();
	const finish = today.add({ days: 2 }).toZonedDateTime(timeZone).toInstant();
	const rows = await repository.listMaterializedTimelineSegments(start.toString(), finish.toString(), channel.id);
	const segments = rows.map(row => row.segment);
	const reference = segments.find(item => item.role === 'primary'
		&& Date.parse(item.airing?.finish ?? item.finish) > now.epochMilliseconds)
	?? segments.find(item => item.role === 'filler' && Date.parse(item.finish) > now.epochMilliseconds);
	const at = reference ? Date.parse(reference.airing?.start ?? reference.start) + elapsedMs : now.epochMilliseconds;
	const segment = segments.find(item => Date.parse(item.start) <= at && at < Date.parse(item.finish)) ?? null;
	const position: GraphicsPreviewPosition = {
		channel, at, segment,
		preview: { availability: 'unavailable', context: emptyGraphicsContext(channel) },
	};
	if (!reference) {
		return position;
	}
	if (!segment || segment.role === 'dead-air') {
		position.preview.availability = 'gap';
		return position;
	}

	if (!includeContext) {
		return position;
	}
	try {
		const deadline = performance.now() + graphicsPreparationBudget.background;
		const contexts = await prepareGraphicsContexts(repository, channel, segments, [segment], timeZone, publicUrl, () => deadline - performance.now());
		const context = contexts.get(segment.id);
		if (context) {
			position.preview = { availability: 'available', context };
		}
	}
	catch {
		// The selected video can still be rendered if optional metadata is unavailable.
	}
	return position;
}
