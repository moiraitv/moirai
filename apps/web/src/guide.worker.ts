import type { GuideEntry, ScheduleGuide, TimelineSegment } from '@moirai/shared';
import { GuideIntervalIndex } from './guide-index';
import { upcomingScheduleSummary } from './channel-schedule-preview';
import type { GuideWorkerReply, GuideWorkerRequest } from './guide-worker-protocol';

/** Dedicated worker endpoint avoids importing DOM-dependent application state. */
const endpoint = self as unknown as { onmessage: (event: MessageEvent<GuideWorkerRequest>) => void; postMessage: (value: GuideWorkerReply) => void };
let snapshot = 0;
let controller: AbortController | null = null;
let fullGuide: ScheduleGuide | null = null;
const listings = new Map<string, GuideIntervalIndex<GuideEntry | TimelineSegment>>();
const segments = new Map<string, GuideIntervalIndex<TimelineSegment>>();

/** Fetch, parse and index away from the browser UI, retaining only the latest request's snapshot. */
async function load(request: Extract<GuideWorkerRequest, { kind: 'load' }>): Promise<void> {
	controller?.abort();
	const current = new AbortController();
	controller = current;
	const response = await fetch(request.url, { credentials: 'same-origin', signal: current.signal });
	const value = await response.json();
	if (!response.ok) {
		endpoint.postMessage({ id: request.id, error: { name: 'ApiError', message: value.message, status: response.status, body: value } });
		return;
	}
	if (controller !== current || current.signal.aborted) {
		throw new DOMException('Guide request superseded', 'AbortError');
	}

	fullGuide = value as ScheduleGuide;
	snapshot = request.id;
	listings.clear();
	segments.clear();
	for (const channel of fullGuide.channels) {
		const source = new GuideIntervalIndex(channel.preview.segments);
		segments.set(channel.channelId, source);
		listings.set(channel.channelId, channel.entries ? new GuideIntervalIndex(channel.entries) : source);
	}
	const guide = { ...fullGuide, channels: fullGuide.channels.map(channel => ({ ...channel,
		preview: { ...channel.preview, segments: [] }, ...(channel.entries ? { entries: [] } : {}),
	})) };
	endpoint.postMessage({ id: request.id, snapshot, guide });
}

endpoint.onmessage = event => {
	const request = event.data;
	if (request.kind === 'clear') {
		controller?.abort();
		controller = null;
		fullGuide = null;
		listings.clear();
		segments.clear();
		snapshot = 0;
		endpoint.postMessage({ id: request.id });
	}
	else if (request.kind === 'summaries') {
		const summaries: NonNullable<GuideWorkerReply['summaries']> = [];
		if (request.snapshot === snapshot && fullGuide) {
			for (const channel of fullGuide.channels) {
				const spans = segments.get(channel.channelId)!.query(request.window.start, request.window.finish);
				summaries.push([channel.channelId, upcomingScheduleSummary({ ...channel.preview, segments: spans }, request.window)]);
			}
		}
		endpoint.postMessage({ id: request.id, snapshot, summaries });
	}
	else if (request.kind === 'query') {
		const result: GuideWorkerReply['listings'] = [];
		if (request.snapshot === snapshot) {
			const indexes = request.range.segmentsOnly ? segments : listings;
			for (const channelId of request.range.channelIds) {
				const index = indexes.get(channelId);
				const values = index?.query(request.range.start, request.range.finish, request.range.minimumDuration) ?? [];
				if (request.range.segmentsOnly && request.range.includeSegmentId) {
					const anchor = index?.get(request.range.includeSegmentId);
					if (anchor && !values.some(value => value.id === anchor.id)) {
						values.push(anchor);
					}
				}
				result.push([channelId, values]);
			}
		}
		endpoint.postMessage({ id: request.id, snapshot, listings: result });
	}
	else {
		void load(request).catch((error: Error) => endpoint.postMessage({ id: request.id, error: { name: error.name, message: error.message } }));
	}
};
