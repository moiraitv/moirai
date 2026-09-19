import { guideProgramNames } from './preview.js';
import { projectGuideEntries } from './projection.js';
import { recoverGuideOccurrences } from './occurrences.js';
import type { ScheduleGuide, SchedulingCatalog, TimelinePreview } from '@moirai/shared';
import { MAX_GUIDE_TIMELINE_SEGMENTS, XMLTV_EPG_DAYS } from '@moirai/shared';
import { Temporal } from '@js-temporal/polyfill';
import type { Repository } from '../repository/index.js';
import type { MaterializedSegmentRecord } from '../repository/contracts.js';
import { generateTimeline } from '../scheduling/engine.js';
import { timelineIssuesInRange } from '../scheduling/timeline-issues.js';
import { schedulingRootProgramIds } from '../scheduling/catalog.js';

import { boundedProjectedWindow, GuideMaterializationLimitError } from './window.js';

export { GuideMaterializationLimitError } from './window.js';

/** Materialized guide window grouped into channel rows. */
export interface MaterializedGuide {
	guide: ScheduleGuide;
	catalog: SchedulingCatalog;
}

/** Signal that a guide request falls outside the durable materialized window. */
export class CommittedGuideRangeError extends Error {
	constructor(
		readonly startDate: string,
		readonly endDate: string,
	) {
		super(`The committed guide is available from ${startDate} through ${endDate}`);
		this.name = 'CommittedGuideRangeError';
	}
}

/** Signal that one or more scheduled channels lack a complete authoritative timeline. */
export class CommittedGuideUnavailableError extends Error {
	readonly statusCode = 503;

	constructor(readonly channelCount: number) {
		super(
			channelCount === 1
				? 'One scheduled channel does not have a complete committed timeline'
				: `${channelCount} scheduled channels do not have complete committed timelines`,
		);
		this.name = 'CommittedGuideUnavailableError';
	}
}

/**
 * Read committed coverage first and materialize only when the stored window is short. Successful
 * reads do not wait for lookahead replenishment.
 */
export async function readCommittedGuideAfterMaterializing<T>(
	read: () => Promise<T>,
	ensureMaterialized: () => Promise<void>,
): Promise<T> {
	try {
		return await read();
	}
	catch (error) {
		if (!(error instanceof CommittedGuideUnavailableError)) {
			throw error;
		}

		await ensureMaterialized();
		return await read();
	}
}

/** Determine whether committed segments continuously cover the requested instant range. */
function coversRange(
	segments: TimelinePreview['segments'],
	rangeStart: string,
	rangeEnd: string,
): boolean {
	let coveredUntil = Temporal.Instant.from(rangeStart);
	const requestedEnd = Temporal.Instant.from(rangeEnd);
	for (const segment of [...segments].sort((left, right) => left.start.localeCompare(right.start))) {
		const start = Temporal.Instant.from(segment.start);
		const finish = Temporal.Instant.from(segment.finish);
		if (Temporal.Instant.compare(finish, coveredUntil) <= 0) {
			continue;
		}

		if (Temporal.Instant.compare(start, coveredUntil) > 0) {
			return false;
		}

		coveredUntil = finish;
		if (Temporal.Instant.compare(coveredUntil, requestedEnd) >= 0) {
			return true;
		}
	}
	return Temporal.Instant.compare(coveredUntil, requestedEnd) >= 0;
}

/** Shorten an oversized guide to the last complete local day before its overflow row. */
export function boundedGuideWindow(
	requestedStart: Temporal.PlainDate,
	requestedEnd: Temporal.PlainDate,
	timeZone: string,
	rows: MaterializedSegmentRecord[],
	limit = MAX_GUIDE_TIMELINE_SEGMENTS,
): {
	days: number;
	endDate: Temporal.PlainDate;
	rows: MaterializedSegmentRecord[];
	segmentLimitApplied: boolean;
} {
	if (rows.length <= limit) {
		return {
			days: requestedStart.until(requestedEnd, { largestUnit: 'days' }).days,
			endDate: requestedEnd,
			rows,
			segmentLimitApplied: false,
		};
	}

	const overflow = rows[limit]!;
	const endDate = Temporal.Instant.from(overflow.segment.start)
		.toZonedDateTimeISO(timeZone)
		.toPlainDate();
	const days = requestedStart.until(endDate, { largestUnit: 'days' }).days;
	if (days < 1) {
		throw new GuideMaterializationLimitError(limit);
	}

	const rangeEnd = endDate.toZonedDateTime(timeZone).toInstant().toString();
	return {
		days,
		endDate,
		rows: rows.filter((row) => row.segment.start < rangeEnd),
		segmentLimitApplied: true,
	};
}

/** Materialize channel schedules through one shared, read-only scheduling pipeline. */
export async function materializeScheduleGuide(
	repository: Repository,
	timeZone: string,
	startDate: string,
	days: number,
): Promise<MaterializedGuide> {
	const programsPromise = repository.listPrograms();
	const [schedules, templates, programs, statesByChannel] = await Promise.all([
		repository.listChannelSchedules(),
		repository.listScheduleTemplates(),
		programsPromise,
		repository.getSelectionStatesByChannel(),
	]);
	const catalog = await repository.getSchedulingCatalog(
		programs,
		schedulingRootProgramIds(templates, schedules),
	);
	const templatesById = new Map(templates.map((template) => [template.id, template]));
	let segmentCount = 0;
	const channels: ScheduleGuide['channels'] = [];
	for (const schedule of schedules) {
		const template = templatesById.get(schedule.defaultTemplateId);
		if (!template) {
			continue;
		}

		const preview: TimelinePreview = generateTimeline({
			channelId: schedule.channelId,
			timeZone,
			startDate,
			days,
			schedule,
			template,
			templates,
			programs,
			catalog,
			state: statesByChannel.get(schedule.channelId) ?? [],
		});
		segmentCount += preview.segments.length;
		if (segmentCount > MAX_GUIDE_TIMELINE_SEGMENTS) {
			throw new GuideMaterializationLimitError(MAX_GUIDE_TIMELINE_SEGMENTS);
		}

		channels.push({ channelId: schedule.channelId, preview });
	}
	return {
		guide: {
			timeZone,
			startDate,
			requestedDays: days,
			days,
			segmentLimitApplied: false,
			channels,
		},
		catalog,
	};
}

let committedGuideGeneration = 0;
const committedGuideCache = new WeakMap<Repository, { generation: number; key: string; value: MaterializedGuide }>();

/** Drop cached committed-guide responses after timeline or channel presentation changes. */
export function invalidateCommittedGuideCache(): void {
	committedGuideGeneration += 1;
}

/** Read the durable guide without advancing selection state or regenerating overlapping rows.
 * Pass `includeMediaCatalog` when XMLTV needs committed media snapshots in `catalog.media`.
 */
export async function readCommittedScheduleGuide(
	repository: Repository,
	timeZone: string,
	startDate: string,
	days: number,
	options: { includeMediaCatalog?: boolean } = {},
): Promise<MaterializedGuide> {
	// Restrict reads to the durable rolling window maintained by the materializer.
	const requestedStart = Temporal.PlainDate.from(startDate);
	const today = Temporal.Now.plainDateISO(timeZone);
	const committedEndDate = today.add({ days: XMLTV_EPG_DAYS });
	const requestedEnd = requestedStart.add({ days });
	if (
		Temporal.PlainDate.compare(requestedStart, today) < 0
		|| Temporal.PlainDate.compare(requestedEnd, committedEndDate) > 0
	) {
		throw new CommittedGuideRangeError(today.toString(), committedEndDate.toString());
	}

	const generation = committedGuideGeneration;
	const rangeStart = requestedStart.toZonedDateTime(timeZone).toInstant().toString();
	const requestedRangeEnd = requestedEnd.toZonedDateTime(timeZone).toInstant().toString();

	const [schedules, catalog, statuses, templates] = await Promise.all([
		repository.listChannelSchedules(),
		repository.getSchedulingCatalog([]),
		repository.listTimelineMaterializations(),
		repository.listScheduleTemplates(),
	]);
	const cacheKey = [
		timeZone,
		startDate,
		String(days),
		...templates.map((template) => `${template.id}:${template.updatedAt}:${JSON.stringify(template.slots.map((slot) => slot.guide))}`),
		...statuses.map((status) => `${status.channelId}:${status.committedAt}:${status.health}:${status.pendingSince ?? ''}`),
		options.includeMediaCatalog ? 'media' : 'guide',
	].join('|');
	const cached = committedGuideCache.get(repository);
	if (cached && cached.generation === generation && cached.key === cacheKey) {
		return cached.value;
	}
	const requestedRows = await repository.listMaterializedTimelineSegmentsForGuide(
		rangeStart,
		requestedRangeEnd,
		MAX_GUIDE_TIMELINE_SEGMENTS + 1,
		schedules.map((schedule) => schedule.channelId),
		Boolean(options.includeMediaCatalog),
	);
	// Resolve source labels and unnamed block titles in one lookup when needed.
	const needsProgramNames = requestedRows.some(row => row.segment.role === 'primary' && row.segment.programId !== null) || templates.some((template) => template.slots.some((slot) =>
		slot.programId && slot.guide?.mode === 'block' && !slot.guide.title.trim()));
	const programNames = new Map(needsProgramNames
		? (await repository.listPrograms()).map((program) => [program.id, program.name] as const)
		: []);

	const bounded = boundedGuideWindow(requestedStart, requestedEnd, timeZone, requestedRows);
	const rangeEnd = bounded.endDate.toZonedDateTime(timeZone).toInstant().toString();
	const rows = bounded.rows;

	// Group segments by channel. XMLTV overlays committed snapshots when the caller asks for catalog media.
	const byChannel = new Map<string, TimelinePreview['segments']>();
	const snapshots = new Map(catalog.media.map((media) => [media.id, media]));
	for (const row of rows) {
		const segments = byChannel.get(row.segment.channelId) ?? [];
		segments.push(row.segment);
		byChannel.set(row.segment.channelId, segments);
		if (row.mediaSnapshot) {
			snapshots.set(row.mediaSnapshot.id, row.mediaSnapshot);
		}
	}
	// Overlay live artwork URLs so listings can show fanart added after a snapshot was committed.
	if (options.includeMediaCatalog) {
		const live = await repository.getSchedulingCatalogForItems(
			[...new Set(rows.flatMap((row) => row.segment.mediaItemId ? [row.segment.mediaItemId] : []))],
		);
		for (const item of live.media) {
			const snapshot = snapshots.get(item.id);
			snapshots.set(item.id, snapshot
				? {
					...snapshot,
					artworkUrl: item.artworkUrl ?? snapshot.artworkUrl,
					posterUrl: item.posterUrl ?? snapshot.posterUrl ?? null,
					landscapeUrl: item.landscapeUrl ?? snapshot.landscapeUrl ?? null,
					fanartUrl: item.fanartUrl ?? snapshot.fanartUrl ?? null,
				}
				: item);
		}
	}
	const committedAt = statuses
		.filter((status) => schedules.some((schedule) => schedule.channelId === status.channelId))
		.map((status) => status.committedAt)
		.filter((value): value is string => Boolean(value))
		.sort()
		.at(0);

	// Reject the guide when any scheduled channel lacks complete healthy coverage.
	const materializationByChannel = new Map(statuses.map((status) => [status.channelId, status]));
	const unavailableChannels = schedules.filter((schedule) => {
		const status = materializationByChannel.get(schedule.channelId);
		const segments = byChannel.get(schedule.channelId) ?? [];
		return (
			!status
			|| status.health === 'failed'
			|| !status.committedAt
			|| Temporal.Instant.compare(status.windowStart, rangeStart) > 0
			|| Temporal.Instant.compare(status.windowEnd, rangeEnd) < 0
			|| !coversRange(segments, rangeStart, rangeEnd)
		);
	});
	if (unavailableChannels.length > 0) {
		throw new CommittedGuideUnavailableError(unavailableChannels.length);
	}

	const projectBlocks = templates.some((template) =>
		template.slots.some((slot) => slot.guide?.mode === 'block'));
	const channels: ScheduleGuide['channels'] = schedules.map((schedule) => {
		const segments = byChannel.get(schedule.channelId) ?? [];
		const entries = projectBlocks
			? projectGuideEntries(
				schedule.channelId,
				segments,
				materializationByChannel.get(schedule.channelId)?.guideOccurrences?.length
					? materializationByChannel.get(schedule.channelId)!.guideOccurrences!
					: materializationByChannel.get(schedule.channelId)?.pendingSince ? [] : recoverGuideOccurrences(
						schedule,
						templates,
						rows.filter((row) => row.segment.channelId === schedule.channelId),
						startDate,
						bounded.days,
						timeZone,
					),
				templates,
				rangeStart,
				rangeEnd,
				programNames,
			)
			: [];
		return {
			channelId: schedule.channelId,
			...(entries.some((entry) => entry.kind === 'block') ? { entries } : {}),
			preview: {
				channelId: schedule.channelId,
				timeZone,
				startDate,
				days: bounded.days,
				programNames: guideProgramNames(segments, programNames),
				segments,
				issues: timelineIssuesInRange(
					materializationByChannel.get(schedule.channelId)?.issues ?? [],
					rangeStart,
					rangeEnd,
				),
				proposedState: [],
			},
		};
	});
	// Projection can split raw items; apply the same complete-day budget to the displayed entries.
	const projectedWindow = boundedProjectedWindow(
		requestedStart,
		bounded.endDate,
		timeZone,
		channels.flatMap((channel) => channel.entries ?? []),
	);
	if (projectedWindow.segmentLimitApplied) {
		Object.assign(bounded, projectedWindow);
		const projectedEnd = bounded.endDate.toZonedDateTime(timeZone).toInstant().toString();
		const endMilliseconds = Date.parse(projectedEnd);
		for (const channel of channels) {
			channel.entries = channel.entries?.filter((entry) => Date.parse(entry.start) < endMilliseconds)
				.map((entry) => Date.parse(entry.finish) > endMilliseconds ? { ...entry, finish: projectedEnd } : entry) ?? [];
			channel.preview.days = bounded.days;
			channel.preview.segments = channel.preview.segments.filter((segment) => Date.parse(segment.start) < endMilliseconds);
			channel.preview.issues = timelineIssuesInRange(materializationByChannel.get(channel.channelId)?.issues ?? [], rangeStart, projectedEnd);
		}
	}

	// Rebuild the public guide shape without exposing persistent selection state.
	const result = {
		guide: {
			timeZone,
			startDate,
			requestedDays: days,
			days: bounded.days,
			segmentLimitApplied: bounded.segmentLimitApplied,
			committedStartDate: today.toString(),
			committedEndDate: committedEndDate.toString(),
			...(committedAt ? { committedAt } : {}),
			channels,
		},
		catalog: { ...catalog, media: [...snapshots.values()] },
	};
	if (committedGuideGeneration === generation) {
		committedGuideCache.set(repository, {
			generation,
			key: cacheKey,
			value: result,
		});
	}

	return result;
}

/** Read one channel's committed guide without allowing other channels to block playback. */
export async function readCommittedChannelScheduleGuide(
	repository: Repository,
	timeZone: string,
	channelId: string,
	startDate: string,
	days: number,
): Promise<ScheduleGuide> {
	const requestedStart = Temporal.PlainDate.from(startDate);
	const today = Temporal.Now.plainDateISO(timeZone);
	const committedEndDate = today.add({ days: XMLTV_EPG_DAYS });
	const requestedEnd = requestedStart.add({ days });
	if (
		Temporal.PlainDate.compare(requestedStart, today) < 0
		|| Temporal.PlainDate.compare(requestedEnd, committedEndDate) > 0
	) {
		throw new CommittedGuideRangeError(today.toString(), committedEndDate.toString());
	}

	const rangeStart = requestedStart.toZonedDateTime(timeZone).toInstant().toString();
	const rangeEnd = requestedEnd.toZonedDateTime(timeZone).toInstant().toString();
	const [schedule, status, rows] = await Promise.all([
		repository.getChannelSchedule(channelId),
		repository.getTimelineMaterialization(channelId),
		repository.listMaterializedTimelineSegments(rangeStart, rangeEnd, channelId),
	]);
	if (!schedule) {
		return {
			timeZone,
			startDate,
			requestedDays: days,
			days,
			segmentLimitApplied: false,
			committedStartDate: today.toString(),
			committedEndDate: committedEndDate.toString(),
			channels: [],
		};
	}

	const segments = rows.map((row) => row.segment);
	if (
		!status
		|| status.health === 'failed'
		|| !status.committedAt
		|| Temporal.Instant.compare(status.windowStart, rangeStart) > 0
		|| Temporal.Instant.compare(status.windowEnd, rangeEnd) < 0
		|| !coversRange(segments, rangeStart, rangeEnd)
	) {
		throw new CommittedGuideUnavailableError(1);
	}

	return {
		timeZone,
		startDate,
		requestedDays: days,
		days,
		segmentLimitApplied: false,
		committedStartDate: today.toString(),
		committedEndDate: committedEndDate.toString(),
		committedAt: status.committedAt,
		channels: [{
			channelId,
			preview: {
				channelId,
				timeZone,
				startDate,
				days,
				segments,
				issues: timelineIssuesInRange(status.issues, rangeStart, rangeEnd),
				proposedState: [],
			},
		}],
	};
}
