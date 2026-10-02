import type { ApiErrorBody, GuideEntry, ScheduleGuide, TimelineSegment } from '@moirai/shared';
import type { GuideWorkerRange, GuideWorkerReply, GuideWorkerRequest } from './guide-worker-protocol';
import { upcomingScheduleSummary, type ScheduleDaySummary, type ScheduleSummaryWindow } from './channel-schedule-preview';

/** HTTP failures retain the application's authentication and retry handling. */
export class GuideWorkerError extends Error {
	constructor(message: string, readonly status?: number, readonly body?: ApiErrorBody) {
		super(message);
	}
}

/** Retain one browser guide worker and weak metadata for compact immutable guide objects. */
let worker: Worker | null = null;
const snapshots = new WeakMap<ScheduleGuide, { id: number; owner: Worker }>();
const pending = new Map<number, { resolve: (value: GuideWorkerReply) => void; reject: (error: Error) => void }>();
let nextId = 1;

/** Lazily start the shared guide owner, failing waiters if its transport becomes unavailable. */
function guideWorker(): Worker {
	if (!worker) {
		worker = new Worker(new URL('./guide.worker.ts', import.meta.url), { type: 'module' });
		worker.onmessage = (event: MessageEvent<GuideWorkerReply>) => {
			const entry = pending.get(event.data.id);
			pending.delete(event.data.id);
			if (event.data.error) {
				const error = event.data.error;
				entry?.reject(error.name === 'AbortError' ? new DOMException(error.message, 'AbortError')
					: new GuideWorkerError(error.message, error.status, error.body));
			}
			else {
				entry?.resolve(event.data);
			}
		};
		worker.onerror = () => {
			for (const entry of pending.values()) {
				entry.reject(new Error('Unable to load the guide worker'));
			}
			pending.clear();
			worker?.terminate();
			worker = null;
		};
	}
	return worker;
}

/** Submit compact requests and retain no full guide on the browser main thread. */
function send(request: Omit<Extract<GuideWorkerRequest, { kind: 'load' }>, 'id'>
	| Omit<Extract<GuideWorkerRequest, { kind: 'query' }>, 'id'>
	| Omit<Extract<GuideWorkerRequest, { kind: 'summaries' }>, 'id'>
	| Omit<Extract<GuideWorkerRequest, { kind: 'clear' }>, 'id'>): Promise<GuideWorkerReply> {
	const target = guideWorker();
	const id = nextId++;
	return new Promise((resolve, reject) => {
		pending.set(id, { resolve, reject });
		try {
			target.postMessage({ ...request, id });
		}
		catch (error) {
			pending.delete(id);
			reject(error);
		}
	});
}

/** Fetch an authenticated committed guide into its worker and return its presentation summary. */
export async function loadWorkerGuide(url: string): Promise<ScheduleGuide> {
	const result = await send({ kind: 'load', url });
	const guide = result.guide!;
	snapshots.set(guide, { id: result.snapshot!, owner: worker! });
	return guide;
}

/** Detect worker-backed snapshots without changing the public guide wire contract. */
export function isWorkerGuide(guide: ScheduleGuide | null): boolean {
	return !!guide && snapshots.has(guide);
}

/** Query only visible channels or inspected block spans; superseded snapshots return no listings. */
export async function queryWorkerGuide(guide: ScheduleGuide, range: GuideWorkerRange): Promise<Map<string, Array<GuideEntry | TimelineSegment>>> {
	const snapshot = snapshots.get(guide);
	if (!snapshot || snapshot.owner !== worker) {
		throw new GuideWorkerError('Guide snapshot is unavailable. Reload the guide.');
	}
	const result = await send({ kind: 'query', snapshot: snapshot.id, range });
	if (result.snapshot !== snapshot.id) {
		throw new DOMException('Guide request superseded', 'AbortError');
	}
	return new Map(result.listings);
}

/** Count rolling programming and dead air where the snapshot's full segments are retained. */
export async function queryGuideSummaries(guide: ScheduleGuide, window: ScheduleSummaryWindow): Promise<Map<string, ScheduleDaySummary>> {
	if (!isWorkerGuide(guide)) {
		return new Map(guide.channels.map(channel => [channel.channelId, upcomingScheduleSummary(channel.preview, window)]));
	}
	const snapshot = snapshots.get(guide)!;
	if (snapshot.owner !== worker) {
		throw new GuideWorkerError('Guide snapshot is unavailable. Reload the guide.');
	}
	const result = await send({ kind: 'summaries', snapshot: snapshot.id, window });
	if (result.snapshot !== snapshot.id) {
		throw new DOMException('Guide request superseded', 'AbortError');
	}
	return new Map(result.summaries);
}

/** Discard authenticated snapshots and pending network reads when the session is cleared. */
export async function clearWorkerGuide(): Promise<void> {
	if (worker) {
		await send({ kind: 'clear' });
	}
}
