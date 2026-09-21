import { audioPreferencesSchema } from './audio.js';
import { z } from 'zod';
import { slotGuideSchema, type GuideEntry } from './guide.js';
import { subtitlePreferencesSchema } from './subtitles.js';
import type { MediaAvailability, SourceAvailability } from './index.js';
import {
	canonicalNumberSet,
	canonicalStringSet,
} from './normalization.js';
import {
	catalogProgramItemFilterShape,
	catalogProgramItemFilterSchema,
	catalogProgramItemQuerySchema,
	sortDirectionSchema,
	validateMediaGenreRules,
	validateMediaDurationRange,
} from './catalog.js';

/** Number of nominal wall-clock seconds represented by a daily template. */
export const SECONDS_PER_SCHEDULING_DAY = 86_400;
/** Longest physical or multipart media duration accepted for scheduling and playback. */
export const MAX_MEDIA_DURATION_MILLISECONDS = 366 * SECONDS_PER_SCHEDULING_DAY * 1_000;
/** Bound shared scheduling contracts resource use for timeline preview days. */
export const MAX_TIMELINE_PREVIEW_DAYS = 14;
/** Bound one channel's timeline generation while supporting dense short-form schedules. */
export const MAX_TIMELINE_SEGMENTS = 50_000;
/** Bound exact occurrence details retained for one aggregated timeline issue. */
export const MAX_TIMELINE_ISSUE_OCCURRENCES = 50;
/** Bound combined guide responses while supporting several dense short-form channels. */
export const MAX_GUIDE_TIMELINE_SEGMENTS = 200_000;
/** Number of committed days exposed through the XMLTV guide. */
export const XMLTV_EPG_DAYS = 14;
/** Default configured capacity for explicit media-item collections. */
export const DEFAULT_MAX_EXPLICIT_MEDIA_ITEMS = 5_000;
/** Absolute contract ceiling for configured explicit media-item collections. */
export const MAX_EXPLICIT_MEDIA_ITEMS = 25_000;
/** Number of new items an existing program may accept without explicit confirmation. */
export const PROGRAM_ITEM_ADDITION_CONFIRMATION_THRESHOLD = 5;
/** SHA-256 token binding a program-addition confirmation to its ordered item identifiers. */
export const programItemAdditionConfirmationTokenSchema = z.string().regex(/^[a-f0-9]{64}$/);
/** Bound shared scheduling contracts resource use for explicit media groups. */
export const MAX_EXPLICIT_MEDIA_GROUPS = 1_000;
/** Bound shared scheduling contracts resource use for channel schedule layers. */
export const MAX_CHANNEL_SCHEDULE_LAYERS = 32;
/** Bound shared scheduling contracts resource use for schedule predicate nodes. */
export const MAX_SCHEDULE_PREDICATE_NODES = 100;
/** Bound shared scheduling contracts resource use for schedule predicate depth. */
export const MAX_SCHEDULE_PREDICATE_DEPTH = 8;
/** Bound shared scheduling contracts resource use for schedule exact dates. */
export const MAX_SCHEDULE_EXACT_DATES = 366;
/** Bound shared scheduling contracts resource use for nfo bytes. */
export const MAX_NFO_BYTES = 2 * 1024 * 1024;
/** Bound shared scheduling contracts resource use for metadata text length. */
export const MAX_METADATA_TEXT_LENGTH = 512;
/** Bound shared scheduling contracts resource use for metadata plot length. */
export const MAX_METADATA_PLOT_LENGTH = 16 * 1024;
/** Bound shared scheduling contracts resource use for metadata list items. */
export const MAX_METADATA_LIST_ITEMS = 128;
/** Bound an authored dynamic-query subset without limiting an unbounded All selection. */
export const MAX_LIBRARY_QUERY_ITEMS = 100_000;
/** Preserve extensive cast and contributor credits without unbounded metadata arrays. */
export const MAX_METADATA_PEOPLE_ITEMS = 512;
/** Bound shared scheduling contracts resource use for xmltv description length. */
export { MAX_XMLTV_DESCRIPTION_LENGTH } from './guide.js';

/** Validate the selection strategy contract at runtime. */
export const selectionStrategySchema = z.discriminatedUnion('type', [
	z.object({ type: z.literal('sequential') }),
	z.object({ type: z.literal('shuffle'), seed: z.string().trim().max(200).default('') }),
	z.object({ type: z.literal('random'), seed: z.string().trim().max(200).default('') }),
	z.object({ type: z.literal('weighted-random'), seed: z.string().trim().max(200).default('') }),
]);
/** Shared wire contract for selection strategy. */
export type SelectionStrategy = z.infer<typeof selectionStrategySchema>;

/** Validate one automatic or manually authored selected-media ordering. */
export const selectedMediaSortSchema = z.discriminatedUnion('type', [
	z.object({ type: z.literal('date-added'), direction: sortDirectionSchema }),
	z.object({ type: z.literal('name'), direction: sortDirectionSchema }),
	z.object({ type: z.literal('release-date'), direction: sortDirectionSchema }),
	z.object({
		type: z.literal('manual'),
		itemIds: z.array(z.uuid()).min(1).max(MAX_EXPLICIT_MEDIA_ITEMS)
			.refine((ids) => new Set(ids).size === ids.length, 'Manual media order must be unique'),
	}),
]);
/** Shared wire contract for selected-media ordering. */
export type SelectedMediaSort = z.infer<typeof selectedMediaSortSchema>;

/** Validate stable ordering for media resolved dynamically from a library query. */
export const libraryQuerySortSchema = z.object({
	type: z.enum(['name', 'date-added', 'release-date']),
	direction: sortDirectionSchema,
});
/** Shared wire contract for dynamic library-query ordering. */
export type LibraryQuerySort = z.infer<typeof libraryQuerySortSchema>;

/** Persist bounded insertion batches without duplicating selected-media identifiers. */
const selectedMediaAdditionBatchesSchema = z.array(
	z.array(z.uuid()).min(1).max(MAX_EXPLICIT_MEDIA_ITEMS),
).min(1).max(MAX_EXPLICIT_MEDIA_ITEMS);

/** Minimum metadata needed to derive one selected-media program order. */
export interface SelectedMediaSortable {
	id: string;
	sortTitle: string;
	year: number | null;
	releaseDate?: string | null;
}

/** Order indexed selected media while retaining input order as the stable tie breaker. */
export function orderSelectedMedia<T extends SelectedMediaSortable>(
	items: T[],
	sort: SelectedMediaSort,
	additionBatches?: string[][],
): T[] {
	if (sort.type === 'manual' || (sort.type === 'date-added' && sort.direction === 'asc')) {
		return [...items];
	}
	if (sort.type === 'date-added') {
		if (!additionBatches) {
			return [...items].reverse();
		}

		const remainingIndexesById = new Map<string, number[]>();
		for (const [index, item] of items.entries()) {
			remainingIndexesById.set(item.id, [
				...(remainingIndexesById.get(item.id) ?? []),
				index,
			]);
		}
		const orderedIndexes = [...additionBatches].reverse().flatMap((batch) => batch.flatMap((itemId) => {
			const index = remainingIndexesById.get(itemId)?.shift();
			return index === undefined ? [] : [index];
		}));
		const remainingIndexes = [...remainingIndexesById.values()].flat().sort((left, right) => left - right);
		return [...orderedIndexes, ...remainingIndexes].map((index) => items[index]!);
	}

	const additionOrder = new Map(items.map((item, index) => [item.id, index]));
	return [...items].sort((left, right) => {
		let compared = 0;
		let missing = false;
		if (sort.type === 'name') {
			compared = left.sortTitle.localeCompare(right.sortTitle, 'en-US', {
				sensitivity: 'base',
			});
		}
		else {
			const leftDate = left.releaseDate ?? (left.year === null ? null : `${left.year}-01-01`);
			const rightDate = right.releaseDate ?? (right.year === null ? null : `${right.year}-01-01`);
			if (leftDate === null || rightDate === null) {
				compared = leftDate === rightDate ? 0 : leftDate === null ? 1 : -1;
				missing = true;
			}
			else {
				compared = leftDate.localeCompare(rightDate);
			}
		}

		const directed = sort.direction === 'desc' && !missing ? -compared : compared;
		return directed || additionOrder.get(left.id)! - additionOrder.get(right.id)!;
	});
}

/** Preserve retained insertion batches and append all newly requested IDs as one ordered batch. */
export function updateSelectedMediaAdditionOrder(
	currentItemIds: string[],
	currentBatches: string[][] | undefined,
	requestedItemIds: string[],
): { itemIds: string[]; additionBatches: string[][] } {
	const requested = new Set(requestedItemIds);
	const current = new Set(currentItemIds);
	const retainedItemIds = currentItemIds.filter((itemId) => requested.has(itemId));
	const retainedBatches = (currentBatches ?? currentItemIds.map((itemId) => [itemId]))
		.map((batch) => batch.filter((itemId) => requested.has(itemId)))
		.filter((batch) => batch.length > 0);
	const addedItemIds = requestedItemIds.filter((itemId) => !current.has(itemId));
	return {
		itemIds: [...retainedItemIds, ...addedItemIds],
		additionBatches: [
			...retainedBatches,
			...(addedItemIds.length > 0 ? [addedItemIds] : []),
		],
	};
}

/** Validate a unique bounded list of explicitly selected media. */
const selectedMediaItemIdsSchema = z
	.array(z.uuid())
	.min(1)
	.max(MAX_EXPLICIT_MEDIA_ITEMS)
	.refine((ids) => new Set(ids).size === ids.length, 'Selected media must be unique');

/** Validate the content source contract at runtime. */
export const contentSourceSchema = z.discriminatedUnion('type', [
	z.object({ type: z.literal('item'), itemId: z.uuid() }),
	z.object({
		type: z.literal('collection'),
		libraryId: z.uuid(),
		itemIds: selectedMediaItemIdsSchema,
		additionBatches: selectedMediaAdditionBatchesSchema.optional(),
		sort: selectedMediaSortSchema.default({ type: 'date-added', direction: 'asc' }),
	}),
	z.object({
		type: z.literal('group'),
		groupId: z.uuid(),
		includeDescendants: z.boolean().default(true),
	}),
	z.object({
		type: z.literal('group-collection'),
		libraryId: z.uuid(),
		groupIds: z
			.array(z.uuid())
			.min(1)
			.max(MAX_EXPLICIT_MEDIA_GROUPS)
			.refine((ids) => new Set(ids).size === ids.length, 'Selected groups must be unique'),
	}),
	z.object({
		type: z.literal('library-query'),
		libraryId: z.uuid(),
		kinds: z
			.array(z.string().trim().min(1).max(64))
			.max(32)
			.default([])
			.transform((values) => canonicalStringSet(values)),
		name: catalogProgramItemFilterShape.name.removeDefault().optional(),
		artist: catalogProgramItemFilterShape.artist,
		album: catalogProgramItemFilterShape.album,
		releaseYearFrom: catalogProgramItemFilterShape.releaseYearFrom.removeDefault().optional(),
		releaseYearTo: catalogProgramItemFilterShape.releaseYearTo.removeDefault().optional(),
		minimumDurationSeconds: catalogProgramItemFilterShape.minimumDurationSeconds.removeDefault().optional(),
		maximumDurationSeconds: catalogProgramItemFilterShape.maximumDurationSeconds.removeDefault().optional(),
		minimumRating: catalogProgramItemFilterShape.minimumRating.removeDefault().optional(),
		minimumUserRating: catalogProgramItemFilterShape.minimumUserRating.removeDefault().optional(),
		addedFrom: catalogProgramItemFilterShape.addedFrom.removeDefault().optional(),
		addedBefore: catalogProgramItemFilterShape.addedBefore.removeDefault().optional(),
		genres: catalogProgramItemFilterShape.genres,
		excludedGenres: catalogProgramItemFilterShape.excludedGenres.optional(),
		genreMatch: catalogProgramItemFilterShape.genreMatch.removeDefault().optional(),
		actor: catalogProgramItemFilterShape.actor.removeDefault().optional(),
		director: catalogProgramItemFilterShape.director.removeDefault().optional(),
		sort: libraryQuerySortSchema.optional(),
		itemLimit: z.number().int().min(1).max(MAX_LIBRARY_QUERY_ITEMS).nullable().optional(),
	}),
]).superRefine((source, context) => {
	if (source.type === 'library-query') {
		validateMediaDurationRange(source, context);
		validateMediaGenreRules({
			genres: source.genres,
			excludedGenres: source.excludedGenres ?? [],
			genreMatch: source.genreMatch ?? 'all',
		}, context);
	}

	if (source.type !== 'collection') {
		return;
	}

	if (source.additionBatches) {
		const additionOrder = source.additionBatches.flat();
		if (
			additionOrder.length !== source.itemIds.length
			|| additionOrder.some((itemId, index) => itemId !== source.itemIds[index])
		) {
			context.addIssue({
				code: 'custom',
				path: ['additionBatches'],
				message: 'Addition batches must partition selected items in insertion order',
			});
		}
	}

	if (source.sort.type !== 'manual') {
		return;
	}

	const selected = new Set(source.itemIds);
	if (
		source.sort.itemIds.length !== source.itemIds.length
		|| source.sort.itemIds.some((itemId) => !selected.has(itemId))
	) {
		context.addIssue({
			code: 'custom',
			path: ['sort', 'itemIds'],
			message: 'Manual media order must contain every selected item exactly once',
		});
	}
});
/** Shared wire contract for content source. */
export type ContentSource = z.infer<typeof contentSourceSchema>;

/** Validate the sequence entry contract at runtime. */
export const sequenceEntrySchema = z.object({
	id: z.uuid(),
	programId: z.uuid(),
	count: z.number().int().min(1).max(10_000),
});
/** Shared wire contract for sequence entry. */
export type SequenceEntry = z.infer<typeof sequenceEntrySchema>;

/** Maximum media entries embedded in one Program sample carousel. */
export const PROGRAM_PREVIEW_ITEM_LIMIT = 12;

/** Default number of recommendations committed in a semantic seed. */
export const DEFAULT_SIMILARITY_QUANTITY = 20;
/** Bound seed size and recommendation work. */
export const MAX_SIMILARITY_QUANTITY = 500;
/** Default exploration balance on the cohesive-to-varied scale. */
export const DEFAULT_SIMILARITY_VARIETY = 35;

/** Default semantic exclusion breadth; higher values exclude more loosely related content. */
export const DEFAULT_SEMANTIC_EXCLUSION_STRICTNESS = 50;

/** Semantic source settings; changes apply only to the next generated set. */
export const similarityProgramConfigSchema = z.object({
	type: z.literal('similarity'),
	sourceProgramId: z.uuid(),
	filter: catalogProgramItemFilterSchema.optional(),
	variety: z.number().int().min(0).max(100).default(DEFAULT_SIMILARITY_VARIETY),
	quantity: z.number().int().min(1).max(MAX_SIMILARITY_QUANTITY).default(DEFAULT_SIMILARITY_QUANTITY),
	exclusionStrictness: z.number().int().min(0).max(100).optional(),
	softPreferences: z.string().trim().max(500).optional(),
	/** Historical wire key; entries are concepts excluded by semantic similarity. */
	hardExclusions: z.array(z.string().trim().min(1).max(100)).max(30)
		.transform((values) => [...new Map(values.map((value) => [value.toLocaleLowerCase('en-US'), value])).values()]).optional(),
	subtitlePreferences: subtitlePreferencesSchema.optional(),
	audioPreferences: audioPreferencesSchema.optional(),
});

/** Theme-based selection shares semantic refinements without referencing another Program. */
export const themeProgramConfigSchema = similarityProgramConfigSchema.omit({ sourceProgramId: true }).extend({
	type: z.literal('theme'),
	libraryId: z.uuid(),
	theme: z.string().trim().min(1).max(500),
});

/** Settings accepted by semantic previews and immutable recommendation decisions. */
export const semanticProgramConfigSchema = z.discriminatedUnion('type', [similarityProgramConfigSchema, themeProgramConfigSchema]);

/** Validate the program config contract at runtime. */
export const programConfigSchema = z.discriminatedUnion('type', [
	similarityProgramConfigSchema,
	themeProgramConfigSchema,
	z.object({
		type: z.literal('content'),
		subtitlePreferences: subtitlePreferencesSchema.optional(),
		audioPreferences: audioPreferencesSchema.optional(),
		source: contentSourceSchema,
		strategy: selectionStrategySchema,
	}),
	z.object({
		type: z.literal('sequence'),
		subtitlePreferences: subtitlePreferencesSchema.optional(),
		audioPreferences: audioPreferencesSchema.optional(),
		entries: z
			.array(sequenceEntrySchema)
			.min(1)
			.max(100)
			.refine((entries) => new Set(entries.map((entry) => entry.id)).size === entries.length, {
				message: 'Sequence entry identifiers must be unique',
			}),
		repeat: z.boolean().default(true),
	}),
]);
/** Shared wire contract for program config. */
export type ProgramConfig = z.infer<typeof programConfigSchema>;

/** Validate the program create contract at runtime. */
export const programCreateSchema = z.object({
	name: z.string().trim().min(1).max(120),
	config: programConfigSchema,
});
/** Validate the program update contract at runtime. */
export const programUpdateSchema = programCreateSchema.partial();
/** Shared wire contract for program create. */
export type ProgramCreate = z.infer<typeof programCreateSchema>;
/** Shared wire contract for program update. */
export type ProgramUpdate = z.infer<typeof programUpdateSchema>;

/** Quick-channel scenario backed by one built-in library category. */
export const quickChannelScenarioSchema = z.enum(['movies', 'shows', 'music-videos']);
/** Shared quick-channel scenario. */
export type QuickChannelScenario = z.infer<typeof quickChannelScenarioSchema>;

/** Simplified source choices accepted by the all-in-one channel setup workflow. */
export const quickChannelSourceSchema = z.discriminatedUnion('type', [
	z.object({
		type: z.literal('library-query'),
		...catalogProgramItemFilterShape,
		sort: libraryQuerySortSchema.default({ type: 'name', direction: 'asc' }),
		itemLimit: z.number().int().min(1).max(MAX_LIBRARY_QUERY_ITEMS).nullable().default(null),
	}),
	z.object({
		type: z.literal('collection'),
		itemIds: selectedMediaItemIdsSchema,
	}),
	z.object({
		type: z.literal('group-collection'),
		groupIds: z.array(z.uuid()).min(1).max(MAX_EXPLICIT_MEDIA_GROUPS)
			.refine((ids) => new Set(ids).size === ids.length, 'Selected groups must be unique'),
	}),
]).superRefine((source, context) => {
	if (source.type === 'library-query') {
		validateMediaDurationRange(source, context);
		validateMediaGenreRules(source, context);
	}
});
/** Shared simplified source for quick channel creation. */
export type QuickChannelSource = z.infer<typeof quickChannelSourceSchema>;

/** Validate one atomic quick-channel setup request. */
export const quickChannelSetupCreateSchema = z.object({
	scenario: quickChannelScenarioSchema,
	libraryId: z.uuid(),
	programName: z.string().trim().min(1).max(120),
	source: quickChannelSourceSchema,
	strategy: selectionStrategySchema,
	channel: z.object({
		number: z.string().trim().min(1).max(32).regex(/^[A-Za-z0-9._-]+$/)
			.refine((value) => value !== '.' && value !== '..', {
				message: 'Channel number cannot be a relative path segment',
			}),
		name: z.string().trim().min(1).max(120),
		group: z.string().trim().max(120).nullable().default(null),
	}),
}).superRefine((input, context) => {
	if (input.source.type === 'group-collection' && input.scenario !== 'shows') {
		context.addIssue({
			code: 'custom',
			path: ['source'],
			message: 'Selected shows or seasons require the shows scenario',
		});
	}
});
/** Shared request for atomically creating a simple playable channel. */
export type QuickChannelSetupCreate = z.infer<typeof quickChannelSetupCreateSchema>;

/** Validate a live preview request for a Quick Setup library query. */
export const quickChannelQueryPreviewRequestSchema = z.object({
	scenario: z.string().trim().min(1).max(64),
	libraryId: z.uuid(),
	...catalogProgramItemFilterShape,
	sort: libraryQuerySortSchema.default({ type: 'name', direction: 'asc' }),
	itemLimit: z.number().int().min(1).max(MAX_LIBRARY_QUERY_ITEMS).nullable().default(null),
	cursor: z.string().regex(/^\d+$/).max(12).nullable().default(null),
	limit: z.number().int().min(1).max(48).default(24),
}).superRefine(validateMediaGenreRules).superRefine(validateMediaDurationRange);
/** Shared request for previewing currently indexed dynamic library-query matches. */
export type QuickChannelQueryPreviewRequest = z.infer<
	typeof quickChannelQueryPreviewRequestSchema
>;

/** Validate a library-page request that creates or extends a selected-items program. */
export const programItemAdditionSchema = z.object({
	destination: z.discriminatedUnion('type', [
		z.object({ type: z.literal('existing'), programId: z.uuid() }),
		z.object({
			type: z.literal('new'),
			name: z.string().trim().min(1).max(120),
			strategy: selectionStrategySchema,
		}),
	]),
	selection: z.discriminatedUnion('type', [
		z.object({
			type: z.literal('items'),
			itemIds: z.array(z.uuid()).min(1).max(MAX_EXPLICIT_MEDIA_ITEMS)
				.refine((ids) => new Set(ids).size === ids.length, 'Selected media must be unique'),
		}),
		z.object({ type: z.literal('query'), query: catalogProgramItemQuerySchema }),
	]),
	confirmedAdditionToken: programItemAdditionConfirmationTokenSchema.optional(),
}).superRefine((input, context) => {
	if (input.destination.type === 'new' && input.confirmedAdditionToken !== undefined) {
		context.addIssue({
			code: 'custom',
			path: ['confirmedAdditionToken'],
			message: 'New programs do not accept an addition confirmation',
		});
	}
});
/** Shared request for creating or extending a selected-items program. */
export type ProgramItemAddition = z.infer<typeof programItemAdditionSchema>;

/** Validate explicit hierarchy groups and a compatible program destination. */
export const programGroupAdditionSchema = z.object({
	destination: programItemAdditionSchema.shape.destination,
	selection: z.object({
		type: z.literal('groups'),
		groupIds: z.array(z.uuid()).min(1).max(MAX_EXPLICIT_MEDIA_GROUPS)
			.refine(ids => new Set(ids).size === ids.length, 'Selected groups must be unique'),
	}),
});
/** Request to retain selected groups in a new or existing program. */
export type ProgramGroupAddition = z.infer<typeof programGroupAdditionSchema>;
/** Result counts refer to groups rather than their current descendant items. */
export interface ProgramGroupAdditionResult {
	program: SchedulingProgram;
	created: boolean;
	addedGroupCount: number;
	alreadySelectedCount: number;
}

/** Shared wire contract for scheduling program. */
export interface SchedulingProgram extends ProgramCreate {
	id: string;
	createdAt: string;
	updatedAt: string;
}

/** Result of adding an explicit or filtered library selection to a program. */
export interface ProgramItemAdditionResult {
	program: SchedulingProgram;
	created: boolean;
	matchedItemCount: number;
	addedItemCount: number;
	alreadySelectedCount: number;
}

/** Validate the filler selection policy contract at runtime. */
export const fillerSelectionPolicySchema = z.enum([
	'next-truncate',
	'next-fit-only',
	'best-fit-only',
	'best-fit-or-truncate',
]);
/** Shared wire contract for filler selection policy. */
export type FillerSelectionPolicy = z.infer<typeof fillerSelectionPolicySchema>;

/** Validate the filler config contract at runtime. */
export const fillerConfigSchema = z.object({
	programId: z.uuid(),
	policy: fillerSelectionPolicySchema.default('best-fit-or-truncate'),
});
/** Shared wire contract for filler config. */
export type FillerConfig = z.infer<typeof fillerConfigSchema>;

/** Validate the slot filler contract at runtime. */
export const slotFillerSchema = z.discriminatedUnion('mode', [
	z.object({ mode: z.literal('inherit') }),
	z.object({ mode: z.literal('disabled') }),
	z.object({ mode: z.literal('configured'), config: fillerConfigSchema }),
]);

/** Validate the start eligibility contract at runtime. */
export const startEligibilitySchema = z.discriminatedUnion('type', [
	z.object({ type: z.literal('require-fit') }),
	z.object({ type: z.literal('allow-truncate') }),
	z.object({ type: z.literal('allow-overrun') }),
	z.object({
		type: z.literal('within-drift'),
		maxDriftSeconds: z.number().int().min(0).max(SECONDS_PER_SCHEDULING_DAY),
	}),
]);
/** Shared wire contract for start eligibility. */
export type StartEligibility = z.infer<typeof startEligibilitySchema>;

/** Validate the schedule slot contract at runtime. */
export const scheduleSlotSchema = z
	.object({
		id: z.uuid(),
		startSeconds: z
			.number()
			.int()
			.min(0)
			.max(SECONDS_PER_SCHEDULING_DAY - 1),
		programId: z.uuid().nullable(),
		stateScope: z.enum(['persistent', 'occurrence']).default('persistent'),
		guide: slotGuideSchema.optional(),
		startEligibility: startEligibilitySchema.default({ type: 'require-fit' }),
		filler: slotFillerSchema.default({ mode: 'inherit' }),
	})
	.superRefine((slot, context) => {
		if (slot.programId === null && slot.filler.mode !== 'disabled') {
			context.addIssue({
				code: 'custom',
				path: ['filler'],
				message: 'A no-program slot must disable slot filler',
			});
		}
	});
/** Shared wire contract for schedule slot. */
export type ScheduleSlot = z.infer<typeof scheduleSlotSchema>;

/** Validate the schedule boundary contract at runtime. */
export const scheduleBoundarySchema = z
	.object({
		id: z.uuid(),
		leftSlotId: z.uuid(),
		rightSlotId: z.uuid(),
		targetSeconds: z.number().int().min(1).max(SECONDS_PER_SCHEDULING_DAY),
		policy: z.enum(['hard', 'finish-left', 'favor-right']).default('hard'),
		maxDriftSeconds: z.number().int().min(0).max(SECONDS_PER_SCHEDULING_DAY).nullable().default(0),
		fallback: z.enum(['truncate-left', 'reject-start', 'favor-right']).default('reject-start'),
		earlyStartMaxDriftSeconds: z.number().int().min(0).max(SECONDS_PER_SCHEDULING_DAY).default(0),
	})
	.superRefine((boundary, context) => {
		if (boundary.maxDriftSeconds === null && boundary.policy !== 'finish-left') {
			context.addIssue({
				code: 'custom',
				path: ['maxDriftSeconds'],
				message: 'Unlimited drift is only valid when finishing the left item',
			});
		}
		if (
			boundary.fallback === 'favor-right'
			&& (boundary.policy !== 'finish-left' || boundary.maxDriftSeconds === null)
		) {
			context.addIssue({
				code: 'custom',
				path: ['fallback'],
				message: 'Starting the right slot early requires finite finish-left drift',
			});
		}
	});
/** Shared wire contract for schedule boundary. */
export interface ScheduleBoundary extends Omit<
	z.infer<typeof scheduleBoundarySchema>,
	'earlyStartMaxDriftSeconds'
> {
	earlyStartMaxDriftSeconds?: number;
}

/** Validate the schedule template create contract at runtime. */
export const scheduleTemplateCreateSchema = z.object({
	name: z.string().trim().min(1).max(120),
	period: z.literal('day').default('day'),
	defaultFiller: fillerConfigSchema.nullable().default(null),
	slots: z.array(scheduleSlotSchema).min(1).max(200),
	boundaries: z.array(scheduleBoundarySchema).min(1).max(200),
});
/** Validate the schedule template update contract at runtime. */
export const scheduleTemplateUpdateSchema = scheduleTemplateCreateSchema.partial();
/** Shared wire contract for schedule template create. */
export interface ScheduleTemplateCreate extends Omit<
	z.infer<typeof scheduleTemplateCreateSchema>,
	'boundaries'
> {
	boundaries: ScheduleBoundary[];
}
/** Shared wire contract for schedule template update. */
export interface ScheduleTemplateUpdate extends Omit<
	z.infer<typeof scheduleTemplateUpdateSchema>,
	'boundaries'
> {
	boundaries?: ScheduleBoundary[] | undefined;
}

/** Shared wire contract for schedule template. */
export interface ScheduleTemplate extends ScheduleTemplateCreate {
	/** Internal scheduling revision timestamp, excluding guide-only edits. */
	schedulingUpdatedAt?: string;
	id: string;
	createdAt: string;
	updatedAt: string;
}

/** Validate the layer boundary contract at runtime. */
export const layerBoundarySchema = z
	.object({
		policy: z.enum(['hard', 'finish-left', 'favor-right']).default('hard'),
		maxDriftSeconds: z.number().int().min(0).max(SECONDS_PER_SCHEDULING_DAY).nullable().default(0),
		fallback: z.enum(['truncate-left', 'reject-start', 'favor-right']).default('truncate-left'),
		earlyStartMaxDriftSeconds: z.number().int().min(0).max(SECONDS_PER_SCHEDULING_DAY).default(0),
	})
	.superRefine((boundary, context) => {
		if (boundary.maxDriftSeconds === null && boundary.policy !== 'finish-left') {
			context.addIssue({
				code: 'custom',
				path: ['maxDriftSeconds'],
				message: 'Unlimited drift is only valid when finishing the outgoing item',
			});
		}
		if (
			boundary.fallback === 'favor-right'
			&& (boundary.policy !== 'finish-left' || boundary.maxDriftSeconds === null)
		) {
			context.addIssue({
				code: 'custom',
				path: ['fallback'],
				message: 'Starting incoming content early requires finite finish-left drift',
			});
		}
	});
/** Shared wire contract for layer boundary. */
export interface LayerBoundary extends Omit<
	z.infer<typeof layerBoundarySchema>,
	'earlyStartMaxDriftSeconds'
> {
	earlyStartMaxDriftSeconds?: number;
}

/** Validate explicit predicate dates in ISO calendar form. */
const calendarDateSchema = z.iso.date();
/** Validate a real month and day for annually recurring predicates. */
const monthDaySchema = z
	.object({
		month: z.number().int().min(1).max(12),
		day: z.number().int().min(1).max(31),
	})
	.refine((value) => {
		const date = new Date(Date.UTC(2000, value.month - 1, value.day));
		return date.getUTCMonth() === value.month - 1 && date.getUTCDate() === value.day;
	}, 'Month and day must form a valid calendar date');

/** Shared wire contract for schedule predicate. */
export type SchedulePredicate
	= | {
		type: 'all' | 'any';
		children: SchedulePredicate[];
	}
	| {
		type: 'months';
		values: number[];
		negated: boolean;
	}
	| {
		type: 'weekdays';
		values: number[];
		negated: boolean;
	}
	| {
		type: 'dates';
		values: string[];
		negated: boolean;
	}
	| {
		type: 'date-range';
		startDate: string;
		endDate: string;
		negated: boolean;
	}
	| {
		type: 'annual-range';
		start: { month: number; day: number };
		end: { month: number; day: number };
		negated: boolean;
	}
	| {
		type: 'time-range';
		startSeconds: number;
		endSeconds: number;
		negated: boolean;
	};

/** Concrete predicate schemas accepted beneath composite condition groups. */
const predicateLeafSchemas = [
	z.object({
		type: z.literal('months'),
		values: z
			.array(z.number().int().min(1).max(12))
			.min(1)
			.max(12)
			.transform(canonicalNumberSet),
		negated: z.boolean().default(false),
	}),
	z.object({
		type: z.literal('weekdays'),
		values: z
			.array(z.number().int().min(1).max(7))
			.min(1)
			.max(7)
			.transform(canonicalNumberSet),
		negated: z.boolean().default(false),
	}),
	z.object({
		type: z.literal('dates'),
		values: z
			.array(calendarDateSchema)
			.min(1)
			.max(MAX_SCHEDULE_EXACT_DATES)
			.transform((values) => canonicalStringSet(values)),
		negated: z.boolean().default(false),
	}),
	z
		.object({
			type: z.literal('date-range'),
			startDate: calendarDateSchema,
			endDate: calendarDateSchema,
			negated: z.boolean().default(false),
		})
		.refine((value) => value.endDate >= value.startDate, 'Date range must end on or after start'),
	z.object({
		type: z.literal('annual-range'),
		start: monthDaySchema,
		end: monthDaySchema,
		negated: z.boolean().default(false),
	}),
	z
		.object({
			type: z.literal('time-range'),
			startSeconds: z
				.number()
				.int()
				.min(0)
				.max(SECONDS_PER_SCHEDULING_DAY - 1),
			endSeconds: z
				.number()
				.int()
				.min(0)
				.max(SECONDS_PER_SCHEDULING_DAY - 1),
			negated: z.boolean().default(false),
		})
		.refine((value) => value.startSeconds !== value.endSeconds, 'Time range cannot be empty'),
] as const;

/** Validate the schedule predicate contract at runtime. */
export const schedulePredicateSchema: z.ZodType<SchedulePredicate> = z.lazy(() =>
	z.union([
		...predicateLeafSchemas,
		z.object({
			type: z.enum(['all', 'any']),
			children: z.array(schedulePredicateSchema).min(1).max(MAX_SCHEDULE_PREDICATE_NODES),
		}),
	]));
z.globalRegistry.add(schedulePredicateSchema, {
	id: 'SchedulePredicate',
	description: 'Recursive calendar and time predicate used by one conditional schedule layer.',
});

/** Count predicate nodes so authored conditions stay within the complexity limit. */
function predicateSize(predicate: SchedulePredicate, depth = 1): { nodes: number; depth: number } {
	if (predicate.type !== 'all' && predicate.type !== 'any') {
		return { nodes: 1, depth };
	}

	return predicate.children.reduce(
		(result, child) => {
			const childSize = predicateSize(child, depth + 1);
			return {
				nodes: result.nodes + childSize.nodes,
				depth: Math.max(result.depth, childSize.depth),
			};
		},
		{ nodes: 1, depth },
	);
}

/** Validate the bounded schedule predicate contract at runtime. */
export const boundedSchedulePredicateSchema = schedulePredicateSchema.superRefine(
	(predicate, context) => {
		const size = predicateSize(predicate);
		if (size.nodes > MAX_SCHEDULE_PREDICATE_NODES) {
			context.addIssue({ code: 'too_big', maximum: MAX_SCHEDULE_PREDICATE_NODES, origin: 'array' });
		}
		if (size.depth > MAX_SCHEDULE_PREDICATE_DEPTH) {
			context.addIssue({ code: 'custom', message: 'Schedule predicate is nested too deeply' });
		}
	},
);

/** Validate the channel schedule layer contract at runtime. */
export const channelScheduleLayerSchema = z.object({
	id: z.uuid(),
	templateId: z.uuid(),
	predicate: boundedSchedulePredicateSchema,
	entryBoundary: layerBoundarySchema.default({
		policy: 'hard',
		maxDriftSeconds: 0,
		fallback: 'truncate-left',
		earlyStartMaxDriftSeconds: 0,
	}),
	exitBoundary: layerBoundarySchema.default({
		policy: 'hard',
		maxDriftSeconds: 0,
		fallback: 'truncate-left',
		earlyStartMaxDriftSeconds: 0,
	}),
});
/** Shared wire contract for channel schedule layer. */
export interface ChannelScheduleLayer extends Omit<
	z.infer<typeof channelScheduleLayerSchema>,
	'entryBoundary' | 'exitBoundary'
> {
	entryBoundary: LayerBoundary;
	exitBoundary: LayerBoundary;
}

/** Validate the channel schedule config contract at runtime. */
export const channelScheduleConfigSchema = z.object({
	defaultTemplateId: z.uuid(),
	layers: z.array(channelScheduleLayerSchema).max(MAX_CHANNEL_SCHEDULE_LAYERS).default([]),
	defaultFiller: fillerConfigSchema.nullable().default(null),
});
/** Shared wire contract for channel schedule config. */
export interface ChannelScheduleConfig extends Omit<
	z.infer<typeof channelScheduleConfigSchema>,
	'layers'
> {
	layers: ChannelScheduleLayer[];
}

/** Shared wire contract for channel schedule. */
export interface ChannelSchedule extends ChannelScheduleConfig {
	channelId: string;
	createdAt: string;
	updatedAt: string;
}

/** Shared wire contract for selection state value. */
export type SelectionStateValue
	= | { type: 'similarity'; seed: SimilaritySeed; consumedItemIds: string[]; recentSeeds?: string[][] | undefined }
		| { type: 'sequential'; nextIndex: number; lastItemId: string | null }
		| {
			type: 'shuffle';
			cycle: number;
			cycleItemIds: string[];
			remainingItemIds: string[];
			lastItemId: string | null;
		}
		| { type: 'random'; counter: number; lastItemId: string | null }
		| { type: 'weighted-random'; counter: number; lastItemId: string | null }
		| { type: 'sequence'; entryIndex: number; selectedInEntry: number; completed: boolean };

/** Shared wire contract for selection state record. */
export interface SelectionStateRecord {
	consumerKey: string;
	configFingerprint: string;
	value: SelectionStateValue;
	updatedAt: string;
}

/** Shared wire contract for schedulable media. */
export interface SchedulableMedia {
	id: string;
	libraryId: string;
	groupId: string | null;
	groupSortKey?: string;
	kind: string;
	title: string;
	sortTitle: string;
	playbackPath: string;
	playbackParts?: Array<{ playbackPath: string; durationSeconds: number }>;
	durationSeconds: number | null;
	seasonNumber: number | null;
	episodeNumber: number | null;
	episodeEndNumber?: number | null;
	/** Artist credits captured for music-video playback labels. */
	artists?: string[];
	/** Music hierarchy and metadata labels used by library filters. */
	artistNames?: string[];
	albumNames?: string[];
	trackNumber?: number | null;
	discNumber?: number | null;
	multipartStatus?: 'none' | 'complete' | 'incomplete' | 'ambiguous';
	genres: string[];
	genreNames: string[];
	/** Indexed keyword labels used by explicit semantic exclusions. */
	tags?: string[];
	plot: string | null;
	year: number | null;
	releaseDate?: string | null;
	dateAddedAt?: string | null;
	rating?: number | null;
	userRating?: number | null;
	actors?: string[];
	directors?: string[];
	artworkUrl: string | null;
	posterUrl?: string | null;
	landscapeUrl?: string | null;
	fanartUrl?: string | null;
	availability: MediaAvailability;
}

/** Maximum completed sets retained in each timeline cursor for deterministic rotation. */
export const SEMANTIC_HISTORY_LIMIT = 10;

/** Immutable recommendation decision shared with scheduling workers and persisted at commit. */
export interface SimilaritySeed {
	programId: string;
	consumerKey: string;
	generation: number;
	itemIds: string[];
	sourceItemIds: string[];
	config: Extract<ProgramConfig, { type: 'similarity' | 'theme' }>;
	createdAt: string;
}

/** Remaining committed scheduling selections for one independent consumer. */
export interface SimilaritySetStatus {
	channelName?: string;
	programId: string;
	consumerKey: string;
	generation: number;
	/** Quantity captured when this immutable set was generated. */
	requestedTotal?: number;
	total: number;
	remaining: number;
}

/** Semantic corpus and durable decisions available to a pure scheduling pass. */
export interface SemanticCatalog {
	preferences?: Record<string, { status: 'pending' | 'ready' | 'failed'; vector?: number[]; error?: string }>;
	unavailableItems?: Record<string, true>;
	preparationError?: string;
	currentSets?: SimilaritySetStatus[];
	vectors: Record<string, number[]>;
	pendingItemIds: string[];
	failedItemIds: string[];
	seeds: SimilaritySeed[];
}

/** Shared wire contract for scheduling catalog. */
export interface SchedulingCatalog {
	semantic?: SemanticCatalog;
	media: SchedulableMedia[];
	/** In-process revision/scope identity used to avoid repeated worker transfers. */
	cacheKey?: string;
	/** Runtime indexes are optional on serialized/test catalogs and rebuilt at process boundaries. */
	mediaById?: ReadonlyMap<string, SchedulableMedia>;
	mediaByLibrary?: ReadonlyMap<string, SchedulableMedia[]>;
	mediaByGroup?: ReadonlyMap<string, SchedulableMedia[]>;
	mediaAliases?: Record<string, string>;
	groupParents: Record<string, string | null>;
	/** Group kinds used to roll episode preference up to its owning show. */
	groupKinds?: Record<string, string>;
	libraryAvailability: Record<string, SourceAvailability>;
	/** Authored enablement stays separate from temporary source health. */
	libraryEnabled?: Record<string, boolean>;
	groupTitles: Record<string, string>;
	libraryNames: Record<string, string>;
}

/** Shared wire contract for scheduling program health. */
export type SchedulingProgramHealth = 'ready' | 'degraded' | 'unavailable' | 'missing' | 'empty';

/** Compact indexed media entry used by program catalog carousels. */
export interface SchedulingProgramPreviewItem {
	id: string;
	libraryId: string;
	title: string;
	year: number | null;
	artworkUrl: string | null;
	availability: MediaAvailability;
}

/** Shared wire contract for scheduling program status. */
export interface SchedulingProgramStatus {
	currentSets?: SimilaritySetStatus[];
	programId: string;
	health: SchedulingProgramHealth;
	sourceLabel: string;
	indexedItemCount: number;
	availableItemCount: number;
	previewItems: SchedulingProgramPreviewItem[];
	/** Read-only sample of available candidates removed by semantic exclusions. */
	excludedPreviewItems?: SchedulingProgramPreviewItem[];
	/** Whether the sample is waiting for local embedding preparation. */
	previewPending?: boolean;
	/** Full related pool size, independent of the carousel display limit. */
	matchingItemCount?: number;
	/** Requested size for future sets; current sets retain their original settings. */
	requestedItemCount?: number;
	/** Failed relevant media and refinement embeddings eligible for explicit retry. */
	failedEmbeddingCount?: number;
}

/** Shared wire contract for scheduling overview. */
export interface SchedulingOverview {
	programs: SchedulingProgram[];
	templates: ScheduleTemplate[];
	channelSchedules: ChannelSchedule[];
	programStatuses: SchedulingProgramStatus[];
}

/** Validate the template assignments contract at runtime. */
export const templateAssignmentsSchema = z.object({
	channelIds: z.array(z.uuid()).max(10_000),
});
/** Shared wire contract for template assignments. */
export type TemplateAssignments = z.infer<typeof templateAssignmentsSchema>;

/** Validate the timeline draft preview contract at runtime. */
export const timelineDraftPreviewSchema = z.object({
	channelId: z.uuid().optional(),
	template: scheduleTemplateCreateSchema.extend({ id: z.uuid() }),
	startDate: z.iso.date().optional(),
	days: z.number().int().min(1).max(MAX_TIMELINE_PREVIEW_DAYS).default(1),
});
/** Shared wire contract for timeline draft preview. */
export type TimelineDraftPreview = z.infer<typeof timelineDraftPreviewSchema>;

/** Validate the channel schedule draft preview contract at runtime. */
export const channelScheduleDraftPreviewSchema = z.object({
	channelId: z.uuid(),
	schedule: channelScheduleConfigSchema,
	startDate: z.iso.date(),
	days: z.number().int().min(1).max(MAX_TIMELINE_PREVIEW_DAYS).default(1),
});
/** Shared wire contract for channel schedule draft preview. */
export type ChannelScheduleDraftPreview = z.infer<typeof channelScheduleDraftPreviewSchema>;

/** Shared wire contract for timeline segment. */
export interface TimelineSegment {
	programAncestry?: string[] | undefined;
	id: string;
	role: 'primary' | 'filler' | 'dead-air';
	channelId: string;
	scheduleLayerId: string | null;
	templateId: string;
	slotId: string;
	programId: string | null;
	mediaItemId: string | null;
	title: string;
	subtitle?: string | undefined;
	playbackPath: string | null;
	playbackParts?: Array<{ playbackPath: string; durationSeconds: number }>;
	start: string;
	finish: string;
	sourceStartSeconds: number;
	sourceFinishSeconds: number | null;
	truncated: boolean;
	posterUrl?: string | null | undefined;
	landscapeUrl?: string | null | undefined;
	fanartUrl?: string | null | undefined;
}

/** Shared wire contract for timeline issue. */
export interface TimelineIssueOccurrence {
	start: string;
	finish: string | null;
	boundaryOrigin: 'template' | 'layer-entry' | 'layer-exit' | null;
}

/** Shared wire contract for one aggregated timeline issue. */
export interface TimelineIssue {
	code: string;
	message: string;
	scheduleLayerId: string | null;
	templateId: string | null;
	slotId: string | null;
	programId: string | null;
	mediaItemId: string | null;
	occurrences?: TimelineIssueOccurrence[];
	occurrenceCount?: number;
}

/** Shared wire contract for timeline preview. */
export interface TimelinePreview {
	/** Current names of source programs referenced by the preview. */
	programNames?: Record<string, string> | undefined;
	/** Guide presentation intervals; segments retain actual playback and diagnostic timing. */
	entries?: GuideEntry[] | undefined;
	channelId: string;
	timeZone: string;
	startDate: string;
	days: number;
	segments: TimelineSegment[];
	issues: TimelineIssue[];
	proposedState: SelectionStateRecord[];
}

/** Shared wire contract for schedule guide. */
export interface ScheduleGuide {
	timeZone: string;
	startDate: string;
	requestedDays: number;
	days: number;
	segmentLimitApplied: boolean;
	/** Inclusive local-date boundary of the durable guide window. */
	committedStartDate?: string;
	/** Exclusive local-date boundary of the durable guide window. */
	committedEndDate?: string;
	committedAt?: string;
	channels: Array<{ channelId: string; preview: TimelinePreview; entries?: GuideEntry[] }>;
}

/** Bounded media metadata shown when a committed guide segment is selected. */
export interface GuideSegmentMediaPreview {
	id: string;
	libraryId: string;
	title: string;
	kind: string;
	durationSeconds: number | null;
	seasonNumber: number | null;
	episodeNumber: number | null;
	episodeEndNumber: number | null;
	genreNames: string[];
	/** Indexed keyword labels used by explicit semantic exclusions. */
	tags?: string[];
	plot: string | null;
	year: number | null;
	artworkUrl: string | null;
	availability: MediaAvailability;
}

/** Source labels and safe metadata for one committed guide segment. */
export interface GuideSegmentDetail {
	segment: Omit<TimelineSegment, 'playbackPath'>;
	media: GuideSegmentMediaPreview | null;
	catalogItemPresent: boolean;
	source: {
		role: TimelineSegment['role'];
		programId: string | null;
		programName: string | null;
		templateId: string;
		templateName: string | null;
		libraryId: string | null;
		libraryName: string | null;
	};
}

/** Shared wire contract for timeline materialization health. */
export type TimelineMaterializationHealth = 'ready' | 'pending' | 'generating' | 'failed';

/** Shared wire contract for channel timeline materialization status. */
export interface ChannelTimelineMaterializationStatus {
	channelId: string;
	health: TimelineMaterializationHealth;
	windowStart: string | null;
	windowEnd: string | null;
	committedAt: string | null;
	pendingSince: string | null;
	applyAfter: string | null;
	lastError: string | null;
}
