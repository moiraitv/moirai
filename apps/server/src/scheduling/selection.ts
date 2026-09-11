import { createHash } from 'node:crypto';
import {
	countLabel,
	MAX_MEDIA_DURATION_MILLISECONDS,
	orderSelectedMedia,
	type ProgramConfig,
	type SchedulableMedia,
	type SchedulingCatalog,
	type SchedulingProgram,
	type SelectionStateRecord,
	type SelectionStateValue,
	type TimelineIssue,
	type TimelineIssueOccurrence,
	type ViewingPreferenceScores,
} from '@moirai/shared';
import { stableJson, stableJsonFingerprint } from '../stable-json.js';
import {
	compareLibraryQueryMedia,
	compareSchedulingMedia,
	libraryQueryStateSource,
	mediaMatchesLibraryQuery,
} from './content-query.js';
import { recordTimelineIssue, type RecordedTimelineIssue } from './timeline-issues.js';

/** Selected media item and the cursor state to persist after playback. */
export interface SelectionResult {
	programAncestry?: string[];
	media: SchedulableMedia;
	state: Map<string, SelectionStateRecord>;
}

/** Constraint used when deciding whether primary content may cross a boundary. */
type SelectionFitMode = 'best-fit' | 'first-fit-arbitrary';

/** Immutable catalog indexes and mutable proposed state used during selection. */
export interface SelectionContext {
	programs: Map<string, SchedulingProgram>;
	catalog: SchedulingCatalog;
	candidateCache: Map<
		string,
		{
			playable: SchedulableMedia[];
			missingDuration: SchedulableMedia[];
			unavailableCount: number;
			missingReferenceMessage: string | null;
			missingMemberMessage: string | null;
		}
	>;
	blockedPrograms: Set<string>;
	/** Count selections rejected by duration so callers can distinguish source failures. */
	fitRejectionCount: number;
	issues: RecordedTimelineIssue[];
	issueKeys: Set<string>;
	issueIndex: Map<string, RecordedTimelineIssue>;
	boundaryOrigin: TimelineIssueOccurrence['boundaryOrigin'];
	templateId: string;
	scheduleLayerId: string | null;
	slotId: string;
	now: string;
	viewingPreferences: ViewingPreferenceScores;
	selectionStart: string;
	occupiedMedia: Array<{ mediaItemId: string; start: string; finish: string }>;
}

/** Remove avoidable exact-item overlaps with other channels at the proposed start instant. */
function collisionFreeCandidates(
	candidates: SchedulableMedia[],
	context: SelectionContext,
): SchedulableMedia[] {
	const startMs = Date.parse(context.selectionStart);
	const available = candidates.filter((candidate) => {
		const finishMs = startMs + candidate.durationSeconds! * 1_000;
		return !context.occupiedMedia.some((occupied) =>
			occupied.mediaItemId === candidate.id
			&& startMs < Date.parse(occupied.finish)
			&& finishMs > Date.parse(occupied.start));
	});
	return available.length > 0 ? available : candidates;
}

/** Return the show ancestor that shares preference across episodes. */
function showIdFor(media: SchedulableMedia, context: SelectionContext): string | null {
	let current = media.groupId;
	const visited = new Set<string>();
	while (current && !visited.has(current)) {
		if (context.catalog.groupKinds?.[current] === 'show') {
			return current;
		}

		visited.add(current);
		current = context.catalog.groupParents[current] ?? null;
	}
	return null;
}

/** Convert a decayed preference signal into a bounded odds multiplier. */
function viewingPreferenceWeight(media: SchedulableMedia, context: SelectionContext): number {
	const itemScore = context.viewingPreferences.itemScores[media.id] ?? 0;
	const showId = showIdFor(media, context);
	const score = showId
		? (itemScore + (context.viewingPreferences.showScores[showId] ?? 0)) / 2
		: itemScore;
	return 1 + (4 * score) / (score + 8);
}

/** Order candidates by a deterministic weighted exponential race. */
function weightedOrder(
	candidates: SchedulableMedia[],
	seed: string,
	consumerKey: string,
	counter: number,
	context: SelectionContext,
): SchedulableMedia[] {
	return [...candidates].sort((left, right) => {
		const key = (candidate: SchedulableMedia): number => {
			const hash = deterministicNumber(`${seed}:${consumerKey}:${counter}:${candidate.id}`);
			const uniform = (hash + 1) / (0xffffffffffff + 2);
			return -Math.log(uniform) / viewingPreferenceWeight(candidate, context);
		};
		return key(left) - key(right) || left.id.localeCompare(right.id);
	});
}

/** Derive a repeatable numeric value from a string seed. */
function deterministicNumber(value: string): number {
	return Number.parseInt(createHash('sha256').update(value).digest('hex').slice(0, 12), 16);
}

/** Return whether a measured duration remains exact and within the playback scheduling limit. */
function usableDurationSeconds(value: number | null): value is number {
	if (value === null || !Number.isFinite(value) || value <= 0) {
		return false;
	}

	const milliseconds = Math.round(value * 1_000);
	return Number.isSafeInteger(milliseconds) && milliseconds <= MAX_MEDIA_DURATION_MILLISECONDS;
}

/** Deep-copy selection state before evaluating a scheduling branch. */
export function cloneState(state: Map<string, SelectionStateRecord>): Map<string, SelectionStateRecord> {
	return new Map(
		[...state].map(([key, record]) => [key, { ...record, value: structuredClone(record.value) }]),
	);
}

/** Return only selection-state records changed by a scheduling decision. */
export function changedStateRecords(
	before: Map<string, SelectionStateRecord>,
	after: Map<string, SelectionStateRecord>,
): SelectionStateRecord[] {
	const changed: SelectionStateRecord[] = [];
	for (const [key, record] of after) {
		const prior = before.get(key);
		if (!prior || stableJson(prior) !== stableJson(record)) {
			changed.push(structuredClone(record));
		}
	}
	return changed.sort((left, right) => left.consumerKey.localeCompare(right.consumerKey));
}

/** Add one deduplicated scheduling issue to the current preview. */
export function addIssue(
	context: SelectionContext,
	issue: Omit<
		TimelineIssue,
		'scheduleLayerId' | 'templateId' | 'slotId' | 'occurrences' | 'occurrenceCount'
	> & {
		scheduleLayerId?: string | null;
		occurrence?: TimelineIssueOccurrence;
	},
): void {
	const scheduleLayerId = Object.hasOwn(issue, 'scheduleLayerId')
		? issue.scheduleLayerId ?? null
		: context.scheduleLayerId;
	recordTimelineIssue(context.issues, context.issueKeys, {
		code: issue.code,
		message: issue.message,
		programId: issue.programId,
		mediaItemId: issue.mediaItemId,
		scheduleLayerId,
		templateId: context.templateId,
		slotId: context.slotId,
	}, issue.occurrence ?? {
		start: context.selectionStart,
		finish: null,
		boundaryOrigin: context.boundaryOrigin,
	}, context.issueIndex);
}

/** Return whether a media group belongs to the requested ancestor without following cycles. */
function isDescendantOf(
	groupId: string | null,
	ancestorId: string,
	parents: Record<string, string | null>,
): boolean {
	let current = groupId;
	const visited = new Set<string>();
	while (current) {
		if (current === ancestorId) {
			return true;
		}

		if (visited.has(current)) {
			return false;
		}

		visited.add(current);
		current = parents[current] ?? null;
	}
	return false;
}

/** Resolve and cache the playable media eligible for a content program. */
function candidatesFor(
	config: Extract<ProgramConfig, { type: 'content' }>,
	context: SelectionContext,
	programId: string,
): SchedulableMedia[] {
	// Replay diagnostics from a prior candidate lookup without rescanning the catalog.
	const cached = context.candidateCache.get(programId);
	if (cached) {
		for (const media of cached.missingDuration) {
			addIssue(context, {
				code: (media.multipartStatus ?? 'none') === 'none'
					? 'media-duration-missing'
					: 'media-multipart-invalid',
				message: (media.multipartStatus ?? 'none') === 'none'
					? `Skipped ${media.title} because it has no usable duration.`
					: `Skipped ${media.title} because its multipart sequence is ${media.multipartStatus}.`,
				programId,
				mediaItemId: media.id,
			});
		}
		if (cached.unavailableCount > 0) {
			addIssue(context, {
				code: 'source-unavailable',
				message: `${countLabel(cached.unavailableCount, 'indexed item')} ${
					cached.unavailableCount === 1 ? 'is' : 'are'
				} temporarily unavailable.`,
				programId,
				mediaItemId: null,
			});
		}
		if (cached.missingMemberMessage) {
			addIssue(context, {
				code: 'source-reference-missing',
				message: cached.missingMemberMessage,
				programId,
				mediaItemId: null,
			});
		}
		if (cached.missingReferenceMessage) {
			addIssue(context, {
				code: 'source-reference-missing',
				message: cached.missingReferenceMessage,
				programId,
				mediaItemId: null,
			});
		}
		if (
			(cached.unavailableCount > 0 && cached.playable.length === 0)
			|| cached.missingReferenceMessage
		) {
			context.blockedPrograms.add(programId);
		}
		return cached.playable;
	}

	// Resolve the smallest available catalog index for the configured source type.
	const source = config.source;
	const mediaById
		= context.catalog.mediaById ?? new Map(context.catalog.media.map((item) => [item.id, item]));
	const mediaByLibrary
		= context.catalog.mediaByLibrary
			?? new Map<string, SchedulableMedia[]>(
				Object.keys(context.catalog.libraryAvailability).map((libraryId) => [
					libraryId,
					context.catalog.media.filter((media) => media.libraryId === libraryId),
				]),
			);
	const canonicalItemId = (id: string): string => context.catalog.mediaAliases?.[id] ?? id;
	let missingReferenceMessage: string | null = null;
	if (source.type === 'item') {
		if (!mediaById.has(canonicalItemId(source.itemId))) {
			missingReferenceMessage = 'The exact item referenced by this program no longer exists.';
		}
	}
	else if (source.type === 'group') {
		if (!Object.prototype.hasOwnProperty.call(context.catalog.groupParents, source.groupId)) {
			missingReferenceMessage = 'The group referenced by this program no longer exists.';
		}
	}
	else {
		if (
			!Object.prototype.hasOwnProperty.call(context.catalog.libraryAvailability, source.libraryId)
		) {
			missingReferenceMessage = 'The library referenced by this program no longer exists.';
		}
	}

	// Filter source members by group ancestry, media kind, and genre constraints.
	const collectionItemIds = source.type === 'collection' && source.sort.type === 'manual'
		? source.sort.itemIds
		: source.type === 'collection'
			? source.itemIds
			: [];
	const candidatePool
		= source.type === 'item'
			? [mediaById.get(canonicalItemId(source.itemId))]
				.filter((media): media is SchedulableMedia => Boolean(media))
			: source.type === 'collection'
				? collectionItemIds.flatMap((itemId) => {
					const media = mediaById.get(canonicalItemId(itemId));
					return media ? [media] : [];
				})
				: source.type === 'library-query' || source.type === 'group-collection'
					? (mediaByLibrary.get(source.libraryId) ?? [])
					: context.catalog.media;
	const matching = candidatePool.filter((media) => {
		if (config.source.type === 'item') {
			return media.id === canonicalItemId(config.source.itemId);
		}

		if (config.source.type === 'group') {
			return config.source.includeDescendants
				? isDescendantOf(media.groupId, config.source.groupId, context.catalog.groupParents)
				: media.groupId === config.source.groupId;
		}

		if (config.source.type === 'group-collection') {
			return (
				media.libraryId === config.source.libraryId
				&& config.source.groupIds.some((groupId) =>
					isDescendantOf(media.groupId, groupId, context.catalog.groupParents))
			);
		}

		if (config.source.type === 'collection') {
			return (
				media.libraryId === config.source.libraryId
				&& config.source.itemIds.some((id) => canonicalItemId(id) === media.id)
			);
		}

		return mediaMatchesLibraryQuery(media, config.source);
	});

	// Report deleted explicit members separately from a missing source container.
	let missingMemberMessage: string | null = null;
	if (source.type === 'collection' && !missingReferenceMessage) {
		const count = source.itemIds.length - matching.length;
		if (count > 0) {
			missingMemberMessage = `${countLabel(count, 'selected item')} ${
				count === 1 ? 'is' : 'are'
			} no longer indexed.`;
		}
	}
	if (source.type === 'group-collection' && !missingReferenceMessage) {
		const count = source.groupIds.filter(
			(groupId) => !Object.prototype.hasOwnProperty.call(context.catalog.groupParents, groupId),
		).length;
		if (count > 0) {
			missingMemberMessage = `${countLabel(count, 'selected media-group reference')} ${
				count === 1 ? 'is' : 'are'
			} no longer indexed.`;
		}
		if (count === source.groupIds.length) {
			missingReferenceMessage = 'All selected media groups are no longer indexed.';
		}
	}
	if (source.type === 'collection' && matching.length === 0 && !missingReferenceMessage) {
		missingReferenceMessage = 'All selected items are no longer indexed.';
	}

	// Limit the authored query set before eligibility checks, matching status and previews.
	const queryMatches = source.type === 'library-query'
		? matching.sort((left, right) => compareLibraryQueryMedia(left, right, source.sort))
		: matching;
	const selected = source.type === 'library-query' && source.itemLimit != null
		? queryMatches.slice(0, source.itemLimit)
		: queryMatches;

	// Exclude unavailable or unmeasured media and cache the resulting diagnostics.
	const unavailable = selected.filter((media) => {
		const sourceAvailability = context.catalog.libraryAvailability[media.libraryId] ?? 'unknown';
		return (
			media.availability !== 'available'
			|| (sourceAvailability !== 'available' && sourceAvailability !== 'degraded')
		);
	});
	const unavailableIds = new Set(unavailable.map((media) => media.id));
	const candidates = selected.filter((media) => !unavailableIds.has(media.id));
	const missingDuration = candidates.filter(
		(media) => !usableDurationSeconds(media.durationSeconds),
	);
	const measured = candidates.filter((media) => usableDurationSeconds(media.durationSeconds));
	const playable = source.type === 'collection'
		? orderSelectedMedia(
			measured,
			source.sort,
			source.additionBatches?.map((batch) => batch.map(canonicalItemId)),
		)
		: source.type === 'library-query'
			? measured
			: measured.sort(compareSchedulingMedia);
	context.candidateCache.set(programId, {
		playable,
		missingDuration,
		unavailableCount: unavailable.length,
		missingReferenceMessage,
		missingMemberMessage,
	});

	// Surface eligibility problems once through the shared issue de-duplicator.
	for (const media of missingDuration) {
		addIssue(context, {
			code: (media.multipartStatus ?? 'none') === 'none'
				? 'media-duration-missing'
				: 'media-multipart-invalid',
			message: (media.multipartStatus ?? 'none') === 'none'
				? `Skipped ${media.title} because it has no usable duration.`
				: `Skipped ${media.title} because its multipart sequence is ${media.multipartStatus}.`,
			programId,
			mediaItemId: media.id,
		});
	}
	if (unavailable.length > 0) {
		addIssue(context, {
			code: 'source-unavailable',
			message: `${countLabel(unavailable.length, 'indexed item')} ${
				unavailable.length === 1 ? 'is' : 'are'
			} temporarily unavailable.`,
			programId,
			mediaItemId: null,
		});
	}
	if (missingMemberMessage) {
		addIssue(context, {
			code: 'source-reference-missing',
			message: missingMemberMessage,
			programId,
			mediaItemId: null,
		});
	}
	if (missingReferenceMessage) {
		addIssue(context, {
			code: 'source-reference-missing',
			message: missingReferenceMessage,
			programId,
			mediaItemId: null,
		});
	}
	if ((unavailable.length > 0 && playable.length === 0) || missingReferenceMessage) {
		context.blockedPrograms.add(programId);
	}
	return playable;
}

/** Return current state, migrate a compatible fingerprint, or initialize a new cursor state. */
function stateFor(
	state: Map<string, SelectionStateRecord>,
	consumerKey: string,
	config: unknown,
	initial: SelectionStateValue,
	now: string,
	compatibleConfig: unknown | null = null,
): SelectionStateRecord {
	const configFingerprint = stableJsonFingerprint(config);
	const existing = state.get(consumerKey);
	if (existing?.value.type === initial.type) {
		if (existing.configFingerprint === configFingerprint) {
			return existing;
		}
		if (
			compatibleConfig !== null
			&& existing.configFingerprint === stableJsonFingerprint(compatibleConfig)
		) {
			const migrated = { ...existing, configFingerprint, updatedAt: now };
			state.set(consumerKey, migrated);
			return migrated;
		}
	}

	const created = { consumerKey, configFingerprint, value: initial, updatedAt: now };
	state.set(consumerKey, created);
	return created;
}

/** Reconstruct the authored collection identity used before set fingerprints were canonicalized. */
function legacySetSelectionStateConfig(config: ProgramConfig): unknown | null {
	if (
		config.type !== 'content'
		|| config.source.type !== 'collection'
		|| config.strategy.type === 'sequential'
		|| config.source.additionBatches !== undefined
	) {
		return null;
	}

	return {
		...config,
		source: {
			type: 'collection',
			libraryId: config.source.libraryId,
			itemIds: config.source.itemIds,
		},
	};
}

/** Exclude presentation preferences and normalize legacy defaults and collection strategy identity. */
function selectionStateConfig(input: ProgramConfig): unknown {
	const { subtitlePreferences: _preferences, audioPreferences: _audio, ...config } = input;
	void _preferences;
	void _audio;
	if (config.type === 'content' && config.source.type === 'library-query') {
		return { ...config, source: libraryQueryStateSource(config.source) };
	}
	if (
		config.type !== 'content'
		|| config.source.type !== 'collection'
	) {
		return config;
	}
	if (config.strategy.type === 'sequential') {
		if (
			config.source.additionBatches === undefined
			&& config.source.sort.type === 'date-added'
			&& config.source.sort.direction === 'asc'
		) {
			return {
				...config,
				source: {
					type: 'collection',
					libraryId: config.source.libraryId,
					itemIds: config.source.itemIds,
				},
			};
		}

		return config;
	}

	return {
		...config,
		source: {
			type: 'collection',
			libraryId: config.source.libraryId,
			itemIds: [...config.source.itemIds].sort(),
		},
	};
}

/** Select one item from a source while applying ordering and fit rules. */
function chooseContent(
	program: SchedulingProgram,
	consumerKey: string,
	state: Map<string, SelectionStateRecord>,
	context: SelectionContext,
	fitSeconds: number | null,
	fitMode: SelectionFitMode,
): SchedulableMedia | null {
	if (program.config.type !== 'content') {
		return null;
	}

	const candidates = candidatesFor(program.config, context, program.id);
	if (candidates.length === 0) {
		if (!context.blockedPrograms.has(program.id)) {
			addIssue(context, {
				code: 'source-empty',
				message: `Program ${program.name} has no playable media.`,
				programId: program.id,
				mediaItemId: null,
			});
		}
		return null;
	}

	const strategy = program.config.strategy;
	const stateConfig = selectionStateConfig(program.config);
	const legacyStateConfig = program.config.source.type === 'library-query'
		? program.config
		: legacySetSelectionStateConfig(program.config);

	// Advance a stable cursor through the source's natural media order.
	if (strategy.type === 'sequential') {
		const record = stateFor(
			state,
			consumerKey,
			stateConfig,
			{ type: 'sequential', nextIndex: 0, lastItemId: null },
			context.now,
			legacyStateConfig,
		);
		const value = record.value as Extract<SelectionStateValue, { type: 'sequential' }>;
		const afterLast = value.lastItemId
			? candidates.findIndex((candidate) => candidate.id === value.lastItemId) + 1
			: value.nextIndex;
		const start
			= afterLast > 0 ? afterLast % candidates.length : value.nextIndex % candidates.length;
		const ordered = candidates.map(
			(_, offset) => candidates[(start + offset) % candidates.length]!,
		);
		const selectable = collisionFreeCandidates(ordered, context);
		const fitting
			= fitSeconds === null
				? selectable[0]!
				: fitMode === 'first-fit-arbitrary'
					? selectable[0]!.durationSeconds! <= fitSeconds
						? selectable[0]!
						: null
					: (selectable
						.filter((candidate) => candidate.durationSeconds! <= fitSeconds)
						.sort(
							(a, b) =>
								b.durationSeconds! - a.durationSeconds!
								|| selectable.indexOf(a) - selectable.indexOf(b),
						)[0] ?? null);
		if (!fitting) {
			return null;
		}

		value.lastItemId = fitting.id;
		value.nextIndex = (candidates.indexOf(fitting) + 1) % candidates.length;
		record.updatedAt = context.now;
		return fitting;
	}

	// Consume a deterministic shuffle cycle without repeats until exhaustion.
	if (strategy.type === 'shuffle') {
		const record = stateFor(
			state,
			consumerKey,
			stateConfig,
			{ type: 'shuffle', cycle: 0, cycleItemIds: [], remainingItemIds: [], lastItemId: null },
			context.now,
			legacyStateConfig,
		);
		const value = record.value as Extract<SelectionStateValue, { type: 'shuffle' }>;
		const availableIds = new Set(candidates.map((candidate) => candidate.id));
		value.cycleItemIds = value.cycleItemIds.filter((id) => availableIds.has(id));
		value.remainingItemIds = value.remainingItemIds.filter((id) => availableIds.has(id));
		const known = new Set(value.cycleItemIds);
		const added = candidates
			.filter((candidate) => !known.has(candidate.id))
			.sort(
				(a, b) =>
					deterministicNumber(`${strategy.seed}:${consumerKey}:${value.cycle}:${a.id}`)
					- deterministicNumber(`${strategy.seed}:${consumerKey}:${value.cycle}:${b.id}`),
			);
		value.remainingItemIds.push(...added.map((candidate) => candidate.id));
		value.cycleItemIds.push(...added.map((candidate) => candidate.id));
		if (value.remainingItemIds.length === 0) {
			value.cycle += 1;
			value.remainingItemIds = [...candidates]
				.sort(
					(a, b) =>
						deterministicNumber(`${strategy.seed}:${consumerKey}:${value.cycle}:${a.id}`)
						- deterministicNumber(`${strategy.seed}:${consumerKey}:${value.cycle}:${b.id}`),
				)
				.map((candidate) => candidate.id);
			value.cycleItemIds = [...value.remainingItemIds];
			if (value.remainingItemIds.length > 1 && value.remainingItemIds[0] === value.lastItemId) {
				value.remainingItemIds.push(value.remainingItemIds.shift()!);
			}
		}
		const ordered = value.remainingItemIds
			.map((id) => candidates.find((candidate) => candidate.id === id))
			.filter((candidate): candidate is SchedulableMedia => Boolean(candidate));
		const selectable = collisionFreeCandidates(ordered, context);
		const selected
			= fitSeconds === null
				? selectable[0]!
				: fitMode === 'first-fit-arbitrary'
					? (selectable.find((candidate) => candidate.durationSeconds! <= fitSeconds) ?? null)
					: (selectable
						.filter((candidate) => candidate.durationSeconds! <= fitSeconds)
						.sort(
							(a, b) =>
								b.durationSeconds! - a.durationSeconds!
								|| selectable.indexOf(a) - selectable.indexOf(b),
						)[0] ?? null);
		if (!selected) {
			return null;
		}

		value.remainingItemIds = value.remainingItemIds.filter((id) => id !== selected.id);
		value.lastItemId = selected.id;
		record.updatedAt = context.now;
		return selected;
	}

	// Draw independently by learned weight while preventing avoidable immediate repeats.
	if (strategy.type === 'weighted-random') {
		const record = stateFor(
			state,
			consumerKey,
			stateConfig,
			{ type: 'weighted-random', counter: 0, lastItemId: null },
			context.now,
			legacyStateConfig,
		);
		const value = record.value as Extract<SelectionStateValue, { type: 'weighted-random' }>;
		let ordered = collisionFreeCandidates(
			weightedOrder(candidates, strategy.seed, consumerKey, value.counter, context),
			context,
		);
		const alternative = ordered.some((candidate) =>
			candidate.id !== value.lastItemId
			&& (fitSeconds === null || candidate.durationSeconds! <= fitSeconds));
		if (alternative && value.lastItemId) {
			ordered = ordered.filter((candidate) => candidate.id !== value.lastItemId);
		}
		const selected = fitSeconds === null
			? ordered[0]!
			: fitMode === 'first-fit-arbitrary'
				? (ordered.find((candidate) => candidate.durationSeconds! <= fitSeconds) ?? null)
				: (ordered
					.filter((candidate) => candidate.durationSeconds! <= fitSeconds)
					.sort((a, b) =>
						b.durationSeconds! - a.durationSeconds! || ordered.indexOf(a) - ordered.indexOf(b))[0]
						?? null);
		if (!selected) {
			return null;
		}

		value.counter += 1;
		value.lastItemId = selected.id;
		record.updatedAt = context.now;
		return selected;
	}

	// Select independently using a deterministic counter-based random order.
	const record = stateFor(
		state,
		consumerKey,
		stateConfig,
		{ type: 'random', counter: 0, lastItemId: null },
		context.now,
		legacyStateConfig,
	);
	const value = record.value as Extract<SelectionStateValue, { type: 'random' }>;
	const ordered = collisionFreeCandidates(
		[...candidates].sort(
			(a, b) =>
				deterministicNumber(`${strategy.seed}:${consumerKey}:${value.counter}:${a.id}`)
				- deterministicNumber(`${strategy.seed}:${consumerKey}:${value.counter}:${b.id}`),
		),
		context,
	);
	const selected
		= fitSeconds === null
			? ordered[0]!
			: fitMode === 'first-fit-arbitrary'
				? (ordered.find((candidate) => candidate.durationSeconds! <= fitSeconds) ?? null)
				: (ordered
					.filter((candidate) => candidate.durationSeconds! <= fitSeconds)
					.sort(
						(a, b) =>
							b.durationSeconds! - a.durationSeconds! || ordered.indexOf(a) - ordered.indexOf(b),
					)[0] ?? null);
	if (!selected) {
		return null;
	}

	value.counter += 1;
	value.lastItemId = selected.id;
	record.updatedAt = context.now;
	return selected;
}

/** Select the next playable item from a program, including composite sequences. */
export function selectProgram(
	programId: string,
	consumerKey: string,
	sourceState: Map<string, SelectionStateRecord>,
	context: SelectionContext,
	fitSeconds: number | null = null,
	fitMode: SelectionFitMode = 'best-fit',
	ancestry: string[] = [],
): SelectionResult | null {
	if (ancestry.includes(programId)) {
		addIssue(context, {
			code: 'program-cycle',
			message: 'A sequence contains a recursive program reference.',
			programId,
			mediaItemId: null,
		});
		return null;
	}

	const program = context.programs.get(programId);
	if (!program) {
		addIssue(context, {
			code: 'program-missing',
			message: 'A referenced program no longer exists.',
			programId,
			mediaItemId: null,
		});
		context.blockedPrograms.add(programId);
		return null;
	}

	const state = cloneState(sourceState);

	// Delegate leaf content programs to the configured selection strategy.
	if (program.config.type === 'content') {
		const media = chooseContent(program, consumerKey, state, context, fitSeconds, fitMode);
		// A nonempty playable pool can fail content selection only on the requested fit limit.
		if (!media && fitSeconds !== null && (context.candidateCache.get(programId)?.playable.length ?? 0) > 0) {
			context.fitRejectionCount += 1;
		}
		return media ? { media, state, programAncestry: [...ancestry, programId] } : null;
	}

	const record = stateFor(
		state,
		consumerKey,
		selectionStateConfig(program.config),
		{ type: 'sequence', entryIndex: 0, selectedInEntry: 0, completed: false },
		context.now,
		program.config,
	);
	const value = record.value as Extract<SelectionStateValue, { type: 'sequence' }>;
	if (value.completed) {
		return null;
	}

	// Walk composite entries until one selects media or the sequence becomes blocked.
	for (let attempts = 0; attempts < program.config.entries.length; attempts += 1) {
		const entry = program.config.entries[value.entryIndex];
		if (!entry) {
			return null;
		}

		const selected = selectProgram(
			entry.programId,
			`${consumerKey}:entry:${entry.id}`,
			state,
			context,
			fitSeconds,
			fitMode,
			[...ancestry, programId],
		);
		if (selected) {
			value.selectedInEntry += 1;
			if (value.selectedInEntry >= entry.count) {
				value.selectedInEntry = 0;
				value.entryIndex += 1;
				if (value.entryIndex >= program.config.entries.length) {
					value.entryIndex = 0;
					value.completed = !program.config.repeat;
				}
			}
			record.updatedAt = context.now;
			selected.state.set(consumerKey, record);
			return selected;
		}

		if (fitSeconds !== null && fitMode === 'first-fit-arbitrary') {
			return null;
		}

		if (context.blockedPrograms.has(entry.programId)) {
			context.blockedPrograms.add(programId);
			return null;
		}

		value.selectedInEntry = 0;
		value.entryIndex += 1;
		if (value.entryIndex >= program.config.entries.length) {
			value.entryIndex = 0;
			if (!program.config.repeat) {
				value.completed = true;
				record.updatedAt = context.now;
				state.set(consumerKey, record);
				return null;
			}
		}
	}
	return null;
}
