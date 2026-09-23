import { applyMaterializationWrite, type MaterializationWriter } from './materialization-writes.js';
import { semanticSchedulingFingerprint } from '../semantic/fingerprint.js';
import { StaleSemanticDecisionError } from '../repository/semantic.js';
import { Temporal } from '@js-temporal/polyfill';
import {
	XMLTV_EPG_DAYS,
	type ChannelSchedule,
	type LiveEvent,
	type ScheduleTemplate,
	type SchedulingCatalog,
	type SchedulingProgram,
	type SelectionStateRecord,
	type ViewingPreferenceScores,
} from '@moirai/shared';
import type { LiveEventPublisher } from '../operations/live-events.js';
import { internalErrorMessage } from '../error-message.js';
import type { Repository } from '../repository/index.js';
import type {
	MaterializedSegmentRecord,
	OccupiedMediaInterval,
	TimelineMaterializationRecord,
} from '../repository/contracts.js';
import { generateTimelineDetailed } from './engine.js';
import { mergeTimelineIssues } from './timeline-issues.js';
import type { SchedulingWorkerPool } from './worker-pool.js';
import { indexSchedulingCatalog, schedulingRootProgramIds } from './catalog.js';
import { mergeGuideOccurrences, recoverGuideOccurrences } from '../guide/occurrences.js';
import { templatePlaybackInput } from './template-playback.js';
import { stableJsonFingerprint } from '../stable-json.js';
import { currentTimestamp, yieldToEventLoop } from '../time.js';

/** Delay between background checks of the durable rolling schedule window. */
const MATERIALIZATION_INTERVAL_MS = 60_000;
/**
 * Extra local day kept beyond the advertised XMLTV window. Yesterday's lookahead day becomes
 * today's 14th advertised day, so midnight does not uncover the far edge before the next pass.
 */
const MATERIALIZED_LOOKAHEAD_DAYS = 1;

/** Return whether a media group is contained by any selected group. */
function belongsToGroup(
	groupId: string | null,
	candidates: Set<string>,
	parents: Record<string, string | null>,
): boolean {
	let current = groupId;
	const visited = new Set<string>();
	while (current && !visited.has(current)) {
		if (candidates.has(current)) {
			return true;
		}

		visited.add(current);
		current = parents[current] ?? null;
	}
	return false;
}

/** Collect every program reachable from the selected schedule resources. */
function referencedPrograms(
	templateIds: Set<string>,
	templates: ScheduleTemplate[],
	programs: SchedulingProgram[],
	seedProgramIds: string[] = [],
): SchedulingProgram[] {
	const ids = new Set<string>(seedProgramIds);
	for (const template of templates) {
		if (!templateIds.has(template.id)) {
			continue;
		}

		for (const slot of template.slots) {
			if (slot.programId) {
				ids.add(slot.programId);
			}
			if (slot.filler.mode === 'configured') {
				ids.add(slot.filler.config.programId);
			}
		}
		if (template.defaultFiller) {
			ids.add(template.defaultFiller.programId);
		}
	}
	let changed = true;
	while (changed) {
		changed = false;
		for (const program of programs) {
			if (ids.has(program.id) && program.config.type === 'similarity' && !ids.has(program.config.sourceProgramId)) {
				ids.add(program.config.sourceProgramId);
				changed = true;
			}
			if (!ids.has(program.id) || program.config.type !== 'sequence') {
				continue;
			}

			for (const entry of program.config.entries) {
				if (!ids.has(entry.programId)) {
					ids.add(entry.programId);
					changed = true;
				}
			}
		}
	}
	return programs.filter((program) => ids.has(program.id));
}

/** Hash programming inputs that determine whether committed future output is stale. */
function inputFingerprint(
	schedule: ChannelSchedule,
	templates: ScheduleTemplate[],
	programs: SchedulingProgram[],
	catalog: SchedulingCatalog,
): string {
	// Restrict templates and recursively referenced programs to this channel schedule.
	const templateIds = new Set([
		schedule.defaultTemplateId,
		...schedule.layers.map((layer) => layer.templateId),
	]);
	const selectedTemplates = templates
		.filter((template) => templateIds.has(template.id))
		.sort((left, right) => left.id.localeCompare(right.id));
	const selectedPrograms = referencedPrograms(
		templateIds,
		templates,
		programs,
		schedule.defaultFiller ? [schedule.defaultFiller.programId] : [],
	).sort((left, right) => left.id.localeCompare(right.id));

	// Collect only catalog scopes that can affect those programs.
	const libraryIds = new Set<string>();
	const itemIds = new Set<string>();
	const groupIds = new Set<string>();
	for (const program of selectedPrograms) {
		if (program.config.type === 'theme') {
			libraryIds.add(program.config.libraryId);
			continue;
		}
		if (program.config.type !== 'content') {
			continue;
		}

		const source = program.config.source;
		if (source.type === 'item') {
			itemIds.add(source.itemId);
		}
		else if (source.type === 'group') {
			groupIds.add(source.groupId);
		}
		else {
			libraryIds.add(source.libraryId);
			if (source.type === 'group-collection') {
				for (const groupId of source.groupIds) {
					groupIds.add(groupId);
				}
			}
		}
	}

	// Include matching media while ignoring transient availability in the durable fingerprint.
	const selectedMedia = catalog.media
		.filter(
			(media) =>
				libraryIds.has(media.libraryId)
				|| itemIds.has(media.id)
				|| belongsToGroup(media.groupId, groupIds, catalog.groupParents),
		)
		.map((media) => ({ ...media, availability: 'ignored' }))
		.sort((left, right) => left.id.localeCompare(right.id));
	const selectedLibraryIds = new Set(libraryIds);
	for (const media of selectedMedia) {
		selectedLibraryIds.add(media.libraryId);
	}

	// Include the ancestor hierarchy and library attributes used during materialization.
	const selectedGroupIds = new Set(groupIds);
	for (const media of selectedMedia) {
		let groupId = media.groupId;
		while (groupId && !selectedGroupIds.has(groupId)) {
			selectedGroupIds.add(groupId);
			groupId = catalog.groupParents[groupId] ?? null;
		}
	}

	// Hash stable authored inputs and catalog eligibility data together.
	return stableJsonFingerprint({
		schedule,
		templates: selectedTemplates.map(templatePlaybackInput),
		programs: selectedPrograms,
		catalog: {
			semantic: semanticSchedulingFingerprint(schedule.channelId, selectedPrograms, catalog),
			media: selectedMedia,
			groupParents: Object.fromEntries(
				[...selectedGroupIds].map((id) => [id, catalog.groupParents[id] ?? null]),
			),
			groupTitles: Object.fromEntries(
				[...selectedGroupIds].map((id) => [id, catalog.groupTitles[id] ?? null]),
			),
			libraryNames: Object.fromEntries(
				[...selectedLibraryIds].map((id) => [id, catalog.libraryNames[id] ?? null]),
			),
			libraryEnabled: Object.fromEntries(
				[...selectedLibraryIds].map((id) => [id, catalog.libraryEnabled?.[id] ?? true]),
			),
		},
	});
}

/** Restore the selection state recorded immediately after a committed segment. */
function stateAfter(
	initial: SelectionStateRecord[],
	segments: MaterializedSegmentRecord[],
	cutoff: string,
): SelectionStateRecord[] {
	const state = new Map(initial.map((record) => [record.consumerKey, structuredClone(record)]));
	for (const record of segments) {
		if (record.segment.start >= cutoff) {
			break;
		}

		for (const changed of record.stateDelta) {
			state.set(changed.consumerKey, structuredClone(changed));
		}
	}
	return [...state.values()].sort((left, right) =>
		left.consumerKey.localeCompare(right.consumerKey));
}

/** Keep only persistent cursor records when advancing the durable window. */
function persistentState(records: SelectionStateRecord[]): SelectionStateRecord[] {
	return records.filter((record) => !/:\d{4}-\d{2}-\d{2}(?::|$)/u.test(record.consumerKey));
}

/** Retain active occurrence cursors when next-day programming began before the window's midnight. */
function windowBaseState(records: SelectionStateRecord[], startDate: string): SelectionStateRecord[] {
	return records.filter((record) => {
		const occurrenceDate = /:(\d{4}-\d{2}-\d{2})(?::|$)/u.exec(record.consumerKey)?.[1];
		return !occurrenceDate || occurrenceDate >= startDate;
	});
}

/** Freeze catalog availability for media already committed to the durable timeline. */
function committedCatalog(catalog: SchedulingCatalog): SchedulingCatalog {
	return indexSchedulingCatalog({
		...catalog,
		// A worker may already hold the live preview catalog for this revision and scope.
		...(catalog.cacheKey ? { cacheKey: `committed:${catalog.cacheKey}` } : {}),
		media: catalog.media.map((media) => ({
			...media,
			availability: catalog.libraryEnabled?.[media.libraryId] === false
				? media.availability
				: 'available',
		})),
		libraryAvailability: Object.fromEntries(
			Object.keys(catalog.libraryAvailability).map((libraryId) => [
				libraryId,
				catalog.libraryEnabled?.[libraryId] === false ? 'unavailable' : 'available',
			]),
		),
	});
}

/**
 * Retry catalog-caused dead air as soon as indexed facts change. Only an entirely empty remaining
 * timeline qualifies, and pending authored edits keep their normal application boundary.
 */
function canRecoverEmptyTimeline(
	current: TimelineMaterializationRecord,
	fingerprint: string,
	existing: MaterializedSegmentRecord[],
	now: string,
	schedule: ChannelSchedule,
	templates: ScheduleTemplate[],
	programs: SchedulingProgram[],
): boolean {
	if (current.inputFingerprint === fingerprint
		|| !current.issues.some((issue) =>
			issue.code === 'source-unavailable' || issue.code === 'media-duration-missing')) {
		return false;
	}

	const remaining = existing.filter((record) => Date.parse(record.segment.finish) > Date.parse(now));
	if (remaining.length === 0 || remaining.some((record) => record.segment.role !== 'dead-air')) {
		return false;
	}

	const templateIds = new Set([
		schedule.defaultTemplateId,
		...schedule.layers.map((layer) => layer.templateId),
	]);
	const authored = [
		schedule,
		...templates.filter((template) => templateIds.has(template.id)).map(templatePlaybackInput),
		...referencedPrograms(
			templateIds,
			templates,
			programs,
			schedule.defaultFiller ? [schedule.defaultFiller.programId] : [],
		),
	];
	return authored.every((resource) => Date.parse(resource.updatedAt) <= Date.parse(current.committedAt));
}

/** Convert an instant to the configured scheduling calendar date. */
function localDate(value: string, timeZone: string): Temporal.PlainDate {
	return Temporal.Instant.from(value).toZonedDateTimeISO(timeZone).toPlainDate();
}

/** Convert a scheduling date to its first instant in the configured time zone. */
function startOfDate(date: Temporal.PlainDate, timeZone: string): string {
	return date.toZonedDateTime(timeZone).toInstant().toString();
}

/** Preserve the established materializer export for issue merging. */
export { mergeTimelineIssues } from './timeline-issues.js';

/**
 * Own the durable rolling schedule and act as the only production cursor-state writer. The
 * materializer reacts to scheduling and catalog changes, generates authoritative future windows,
 * and commits segments, selection state, and health as one persistence workflow.
 */
export class TimelineMaterializer {
	private timer: NodeJS.Timeout | null = null;
	private active: Promise<void> | null = null;
	private running = false;
	private dirty = true;
	private lastCheckedAt = 0;
	private lastCheckedLocalDate: string | null = null;
	private revision = 0;
	private closed = false;

	constructor(
		private readonly repository: Repository,
		private readonly events: LiveEventPublisher,
		private readonly timeZone: string,
		private readonly workers?: SchedulingWorkerPool,
		private readonly write: MaterializationWriter = async command => applyMaterializationWrite(repository, command),
	) {}

	/** Report invalidation observed during an active pass so its owner can retry. */
	get needsRefresh(): boolean {
		return this.dirty;
	}

	/** Return whether the rolling materializer is accepting background work. */
	health(): { status: 'ready' | 'degraded'; detail?: string } {
		return this.running
			? { status: 'ready' }
			: { status: 'degraded', detail: 'Timeline materializer is not running' };
	}

	/** Start periodic rolling timeline materialization. */
	start(): void {
		if (this.running) {
			return;
		}

		this.closed = false;
		this.running = true;
		void this.runNow()
			.catch(() => undefined)
			.finally(() => this.schedule());
	}

	/** Stop scheduled work and wait for the active materialization to settle. */
	async close(): Promise<void> {
		this.closed = true;
		this.running = false;
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		await this.active?.catch(() => undefined);
	}

	/** Mark timelines dirty when scheduling or playable catalog inputs change. */
	handleEvent(event: LiveEvent): void {
		const relevantScan = event.type === 'scan.changed' && event.data.affectsProgramming;
		const relevantReconciliation
			= event.type === 'library.changed' && event.data.affectsProgramming;
		if (event.type === 'scheduling.changed' && event.data.entity === 'guide-template') {
			return;
		}

		if (event.type === 'scheduling.changed' || event.type === 'embeddings.changed' || relevantScan || relevantReconciliation) {
			this.dirty = true;
			this.revision += 1;
			void this.runNow().catch(() => undefined);
		}
	}

	/** Materialize rolling timelines now, sharing one active pass across callers. */
	async runNow(force = false): Promise<void> {
		if (this.active) {
			if (force) {
				this.dirty = true;
				this.revision += 1;
			}
			await this.active;
			if (!this.closed && this.dirty) {
				return this.runNow();
			}

			return;
		}

		const today = Temporal.Now.plainDateISO(this.timeZone).toString();
		if (
			!force
			&& !this.dirty
			&& Date.now() - this.lastCheckedAt < MATERIALIZATION_INTERVAL_MS
			&& this.lastCheckedLocalDate === today
		) {
			return;
		}

		const revision = this.revision;
		this.active = this.materializeAll();
		try {
			await this.active;
			this.dirty = revision !== this.revision;
			this.lastCheckedAt = Date.now();
			this.lastCheckedLocalDate = today;
		}
		finally {
			this.active = null;
		}
	}

	/** Apply pending schedule configuration after the current committed item. */
	async applyNow(channelId: string): Promise<void> {
		if (this.active) {
			await this.active;
		}
		const now = Temporal.Now.instant()
			.round({ smallestUnit: 'second', roundingMode: 'ceil' })
			.toString();
		await this.write({ kind: 'pending', channelIds: [channelId], applyAfter: now, pendingSince: now });
		this.dirty = true;
		this.revision += 1;
		this.events.publish({ type: 'timeline.changed', data: { channelId, status: 'pending' } });
		await this.runNow(true);
	}

	/** Schedule the next rolling materialization if one is not already queued. */
	private schedule(): void {
		if (!this.running) {
			return;
		}

		this.timer = setTimeout(() => {
			this.timer = null;
			void this.runNow()
				.catch(() => undefined)
				.finally(() => this.schedule());
		}, MATERIALIZATION_INTERVAL_MS);
		this.timer.unref();
	}

	/** Refresh each configured channel using one shared catalog snapshot. */
	private async materializeAll(): Promise<void> {
		if (this.workers?.databaseBacked) {
			const retry = await this.workers.materialize(this.timeZone, this.write, event => this.events.publish(event));
			if (retry) {
				this.revision += 1;
				this.dirty = true;
			}
			return;
		}

		const programsPromise = this.repository.listPrograms();
		const [schedules, templates, programs, playbackSettings] = await Promise.all([
			this.repository.listChannelSchedules(),
			this.repository.listScheduleTemplates(),
			programsPromise,
			this.repository.getPlaybackSettings(),
		]);
		if (schedules.length === 0) {
			return;
		}
		const preferenceAsOf = currentTimestamp();
		const viewingPreferences = playbackSettings.viewingPreferencesEnabled
			? this.repository.viewingPreferenceScores(preferenceAsOf)
			: { itemScores: {}, showScores: {} };
		const catalog = await this.repository.getSchedulingCatalog(
			programs,
			schedulingRootProgramIds(templates, schedules),
		);
		const occupancyStart = currentTimestamp();
		const today = Temporal.Instant.from(occupancyStart).toZonedDateTimeISO(this.timeZone).toPlainDate();
		// One extra local day past the stored window covers DST-length days and far-edge overruns.
		const occupancyEnd = startOfDate(
			today.add({ days: XMLTV_EPG_DAYS + MATERIALIZED_LOOKAHEAD_DAYS + 1 }),
			this.timeZone,
		);
		const occupiedMedia = await this.repository.listOccupiedMediaIntervals(
			occupancyStart,
			occupancyEnd,
		);
		const orderedSchedules = [...schedules].sort((left, right) =>
			left.channelId.localeCompare(right.channelId));
		const priorityDate = today;
		const priorityDay = Temporal.PlainDate.from('1970-01-01')
			.until(priorityDate, { largestUnit: 'days' }).days;
		const rotation = orderedSchedules.length === 0
			? 0
			: priorityDay % orderedSchedules.length;
		orderedSchedules.push(...orderedSchedules.splice(0, rotation));
		let index = 0;
		let ready: (() => Promise<void>) | null = null;
		while (index < orderedSchedules.length || ready) {
			const upcoming = index < orderedSchedules.length
				? this.materializeChannel(
					orderedSchedules[index++]!,
					templates,
					programs,
					catalog,
					viewingPreferences,
					occupiedMedia,
				)
				: null;
			// Observe preparation failures while a previous commit awaits its writer acknowledgement.
			void upcoming?.catch(() => undefined);
			if (ready) {
				await ready();
			}
			if (!upcoming) {
				break;
			}

			try {
				ready = await upcoming;
			}
			catch (error) {
				ready = null;
				const message = internalErrorMessage(error);
				await this.write({ kind: 'failed', channelId: orderedSchedules[index - 1]!.channelId, message, failedAt: currentTimestamp() });
				this.events.publish({
					type: 'timeline.changed',
					data: { channelId: orderedSchedules[index - 1]!.channelId, status: 'failed' },
				});
			}
			await yieldToEventLoop();
		}
	}

	/** Generate one channel's missing window and return a commit that must run in occupancy order. */
	private async materializeChannel(
		schedule: ChannelSchedule,
		templates: ScheduleTemplate[],
		programs: SchedulingProgram[],
		sourceCatalog: SchedulingCatalog,
		viewingPreferences: ViewingPreferenceScores,
		occupiedMedia: OccupiedMediaInterval[],
	): Promise<(() => Promise<void>) | null> {
		// Resolve the base template and desired rolling guide window.
		const template = templates.find((candidate) => candidate.id === schedule.defaultTemplateId);
		if (!template) {
			return null;
		}

		const now = Temporal.Now.instant().round({ smallestUnit: 'second', roundingMode: 'ceil' });
		const today = now.toZonedDateTimeISO(this.timeZone).toPlainDate();
		const desiredStart = startOfDate(today, this.timeZone);
		const desiredEndDate = today.add({ days: XMLTV_EPG_DAYS + MATERIALIZED_LOOKAHEAD_DAYS });
		const desiredEnd = startOfDate(desiredEndDate, this.timeZone);
		const currentFingerprint = inputFingerprint(schedule, templates, programs, sourceCatalog);

		// Load the current commit and its state-bearing segments once.
		let current = await this.repository.getTimelineMaterialization(schedule.channelId);
		const retryingFailure = current?.health === 'failed';
		const existing = current
			? await this.repository.listMaterializedTimelineSegments(
				current.windowStart,
				current.continuationAt,
				schedule.channelId,
			)
			: [];
		const recoveringEmptyTimeline = current && canRecoverEmptyTimeline(
			current,
			currentFingerprint,
			existing,
			now.toString(),
			schedule,
			templates,
			programs,
		);
		const retryImmediately = retryingFailure || recoveringEmptyTimeline;

		// Stage changed configuration at the next local-day boundary.
		if (
			current
			&& !retryImmediately
			&& current.inputFingerprint !== currentFingerprint
			&& !current.pendingSince
		) {
			const applyAfter = startOfDate(today.add({ days: 1 }), this.timeZone);
			const pendingSince = now.toString();
			await this.write({ kind: 'pending', channelIds: [schedule.channelId], applyAfter, pendingSince });
			current = { ...current, health: 'pending', pendingSince, applyAfter };
			this.events.publish({
				type: 'timeline.changed',
				data: { channelId: schedule.channelId, status: 'pending' },
			});
		}

		if (
			!recoveringEmptyTimeline
			&& current?.applyAfter
			&& Temporal.Instant.compare(now, current.applyAfter) < 0
		) {
			return null;
		}

		// Choose the replacement boundary and reconstruct selection state at that instant.
		let replaceFrom = desiredStart;
		let initialState: SelectionStateRecord[] = [];
		let baseState: SelectionStateRecord[] = [];
		if (current) {
			baseState = windowBaseState(stateAfter(current.baseState, existing, desiredStart), today.toString());
			if (current.applyAfter && !recoveringEmptyTimeline) {
				replaceFrom = current.applyAfter;
				const active = existing.find(
					({ segment }) =>
						segment.start < replaceFrom
						&& segment.finish > replaceFrom
						&& segment.role !== 'dead-air',
				);
				if (active) {
					replaceFrom = active.segment.finish;
				}
				initialState = stateAfter(current.baseState, existing, replaceFrom);
			}
			else if (retryImmediately) {
				replaceFrom
					= Temporal.Instant.compare(now, Temporal.Instant.from(desiredStart)) > 0
						? now.toString()
						: desiredStart;
				const active = existing.find(
					({ segment }) =>
						segment.start < replaceFrom
						&& segment.finish > replaceFrom
						&& segment.role !== 'dead-air',
				);
				if (active) {
					replaceFrom = active.segment.finish;
				}
				initialState = stateAfter(current.baseState, existing, replaceFrom);
			}
			else if (Temporal.Instant.compare(current.windowEnd, desiredEnd) < 0
				|| Temporal.Instant.compare(current.continuationAt, current.windowEnd) < 0) {
				// Also repair older commits that advertised time beyond their generated tail.
				replaceFrom = current.continuationAt;
				initialState = stateAfter(current.baseState, existing, replaceFrom);
			}
			else {
				return null;
			}
		}
		else {
			initialState = await this.repository.getSelectionState(schedule.channelId);
			baseState = persistentState(initialState);
		}

		if (replaceFrom >= desiredEnd) {
			return null;
		}

		// Generate only the missing or replaceable part of the rolling window.
		const generationDate = localDate(replaceFrom, this.timeZone);
		const days = Math.max(1, generationDate.until(desiredEndDate, { largestUnit: 'days' }).days);
		const catalog = committedCatalog(sourceCatalog);
		const initialContinuation = current?.inputFingerprint === currentFingerprint
			? existing.findLast((record) => Temporal.Instant.compare(record.segment.finish, replaceFrom) === 0)?.continuation ?? null
			: null;
		const generated = this.workers
			? await this.workers.generate({
				channelId: schedule.channelId,
				timeZone: this.timeZone,
				startDate: generationDate.toString(),
				days,
				schedule,
				template,
				templates,
				programs,
				catalog,
				state: initialState,
				viewingPreferences,
				occupiedMedia: occupiedMedia
					.filter((entry) => entry.channelId !== schedule.channelId)
					.map(({ mediaItemId, start, finish }) => ({ mediaItemId, start, finish })),
				initialCursor: replaceFrom,
				initialContinuation,
			})
			: generateTimelineDetailed({
				channelId: schedule.channelId,
				timeZone: this.timeZone,
				startDate: generationDate.toString(),
				days,
				schedule,
				template,
				templates,
				programs,
				catalog,
				state: initialState,
				viewingPreferences,
				occupiedMedia: occupiedMedia
					.filter((entry) => entry.channelId !== schedule.channelId)
					.map(({ mediaItemId, start, finish }) => ({ mediaItemId, start, finish })),
				initialCursor: replaceFrom,
				initialContinuation,
			});

		// Snapshot media labels and state deltas so committed output survives catalog changes.
		const transitions = new Map(
			generated.stateTransitions.map((transition) => [transition.segmentId, transition]),
		);
		const media = new Map(catalog.media.map((item) => [item.id, item]));
		const segments: MaterializedSegmentRecord[] = generated.segments
			.filter((segment) => segment.start < desiredEnd)
			.map((segment) => ({
				segment,
				mediaSnapshot: segment.mediaItemId
					? (() => {
						const item = media.get(segment.mediaItemId);
						if (!item) {
							return null;
						}

						const parentId = item.groupId ? catalog.groupParents[item.groupId] : null;
						return {
							...item,
							seriesTitle: item.kind === 'episode' && item.groupId
								? (catalog.groupTitles[parentId ?? item.groupId] ?? null)
								: null,
						};
					})()
					: null,
				stateDelta: transitions.get(segment.id)?.stateDelta ?? [],
				continuation: transitions.get(segment.id)?.continuation ?? null,
			}));

		// Replacing an active gap must preserve the elapsed portion of the advertised guide.
		const interruptedGap = existing.find(({ segment }) =>
			segment.role === 'dead-air'
			&& Temporal.Instant.compare(segment.start, replaceFrom) < 0
			&& Temporal.Instant.compare(segment.finish, replaceFrom) > 0);
		if (interruptedGap) {
			segments.unshift({
				...interruptedGap,
				segment: { ...interruptedGap.segment, finish: replaceFrom },
				stateDelta: [],
				continuation: null,
			});
		}

		// Atomically commit the replacement range and notify guide and playout consumers.
		const committedAt = currentTimestamp();
		// The final advertised item can consume slots beyond midnight. Keep those warnings for the roll.
		const issueWindowEnd = Temporal.Instant.compare(generated.continuationAt, desiredEnd) > 0
			? generated.continuationAt : desiredEnd;
		const issues = mergeTimelineIssues(
			current?.issues ?? [],
			generated.issues,
			desiredStart,
			replaceFrom,
			issueWindowEnd,
		);
		for (let index = occupiedMedia.length - 1; index >= 0; index -= 1) {
			const entry = occupiedMedia[index]!;
			if (entry.channelId === schedule.channelId && entry.finish > replaceFrom) {
				occupiedMedia.splice(index, 1);
			}
		}
		occupiedMedia.push(...segments
			.filter((record) => Boolean(record.segment.mediaItemId))
			.map((record) => ({
				channelId: schedule.channelId,
				mediaItemId: record.segment.mediaItemId!,
				start: record.segment.start,
				finish: record.segment.finish,
			})));
		const guideOccurrences = mergeGuideOccurrences(
			current?.guideOccurrences?.length ? current.guideOccurrences
				: current && current.inputFingerprint === currentFingerprint ? recoverGuideOccurrences(
					schedule,
					templates,
					existing,
					localDate(current.windowStart, this.timeZone).toString(),
					XMLTV_EPG_DAYS + MATERIALIZED_LOOKAHEAD_DAYS,
					this.timeZone,
				) : [],
			generated.guideOccurrences,
			desiredStart,
			desiredEnd,
			replaceFrom,
		);
		return async () => {
			try {
				await this.write({ kind: 'commit', input: {
					expectedCommittedAt: current?.committedAt ?? null,
					expectedRevision: current?.revision ?? 0,
					channelId: schedule.channelId,
					windowStart: desiredStart,
					windowEnd: desiredEnd,
					replaceFrom,
					continuationAt: generated.continuationAt,
					inputFingerprint: currentFingerprint,
					baseState,
					finalState: persistentState(generated.proposedState),
					guideOccurrences,
					segments,
					issues,
					committedAt,
				} });
				this.events.publish({
					type: 'timeline.changed',
					data: { channelId: schedule.channelId, status: 'ready' },
				});
			}
			catch (error) {
				if (error instanceof StaleSemanticDecisionError) {
					this.dirty = true;
					this.revision += 1;
					return;
				}
				const message = internalErrorMessage(error);
				await this.write({ kind: 'failed', channelId: schedule.channelId, message, failedAt: currentTimestamp() });
				this.events.publish({
					type: 'timeline.changed',
					data: { channelId: schedule.channelId, status: 'failed' },
				});
			}
		};
	}
}
