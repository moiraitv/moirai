import { z } from 'zod';
import type { MediaAvailability, SourceAvailability } from './index.js';
import {
	canonicalGenreKey,
	canonicalNumberSet,
	canonicalStringSet,
} from './normalization.js';
import { catalogProgramItemQuerySchema } from './catalog.js';

/** Number of nominal wall-clock seconds represented by a daily template. */
export const SECONDS_PER_SCHEDULING_DAY = 86_400;
/** Longest physical or multipart media duration accepted for scheduling and playback. */
export const MAX_MEDIA_DURATION_MILLISECONDS = 366 * SECONDS_PER_SCHEDULING_DAY * 1_000;
/** Bound shared scheduling contracts resource use for timeline preview days. */
export const MAX_TIMELINE_PREVIEW_DAYS = 14;
/** Bound one channel's timeline generation while supporting dense short-form schedules. */
export const MAX_TIMELINE_SEGMENTS = 50_000;
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
/** Preserve extensive cast and contributor credits without unbounded metadata arrays. */
export const MAX_METADATA_PEOPLE_ITEMS = 512;
/** Bound shared scheduling contracts resource use for xmltv description length. */
export const MAX_XMLTV_DESCRIPTION_LENGTH = 4 * 1024;

/** Validate the selection strategy contract at runtime. */
export const selectionStrategySchema = z.discriminatedUnion('type', [
	z.object({ type: z.literal('sequential') }),
	z.object({ type: z.literal('shuffle'), seed: z.string().trim().max(200).default('') }),
	z.object({ type: z.literal('random'), seed: z.string().trim().max(200).default('') }),
]);
/** Shared wire contract for selection strategy. */
export type SelectionStrategy = z.infer<typeof selectionStrategySchema>;

/** Validate the content source contract at runtime. */
export const contentSourceSchema = z.discriminatedUnion('type', [
	z.object({ type: z.literal('item'), itemId: z.uuid() }),
	z.object({
		type: z.literal('collection'),
		libraryId: z.uuid(),
		itemIds: z
			.array(z.uuid())
			.min(1)
			.max(MAX_EXPLICIT_MEDIA_ITEMS)
			.refine((ids) => new Set(ids).size === ids.length, 'Selected media must be unique'),
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
		genres: z
			.array(z.string().trim().min(1).max(120))
			.max(64)
			.default([])
			.transform((values) => canonicalStringSet(values, canonicalGenreKey)),
	}),
]);
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

/** Validate the program config contract at runtime. */
export const programConfigSchema = z.discriminatedUnion('type', [
	z.object({
		type: z.literal('content'),
		source: contentSourceSchema,
		strategy: selectionStrategySchema,
	}),
	z.object({
		type: z.literal('sequence'),
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
		fallback: z.enum(['truncate-left', 'reject-start']).default('reject-start'),
	})
	.superRefine((boundary, context) => {
		if (boundary.maxDriftSeconds === null && boundary.policy !== 'finish-left') {
			context.addIssue({
				code: 'custom',
				path: ['maxDriftSeconds'],
				message: 'Unlimited drift is only valid when finishing the left item',
			});
		}
	});
/** Shared wire contract for schedule boundary. */
export type ScheduleBoundary = z.infer<typeof scheduleBoundarySchema>;

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
export type ScheduleTemplateCreate = z.infer<typeof scheduleTemplateCreateSchema>;
/** Shared wire contract for schedule template update. */
export type ScheduleTemplateUpdate = z.infer<typeof scheduleTemplateUpdateSchema>;

/** Shared wire contract for schedule template. */
export interface ScheduleTemplate extends ScheduleTemplateCreate {
	id: string;
	createdAt: string;
	updatedAt: string;
}

/** Validate the layer boundary contract at runtime. */
export const layerBoundarySchema = z
	.object({
		policy: z.enum(['hard', 'finish-left', 'favor-right']).default('hard'),
		maxDriftSeconds: z.number().int().min(0).max(SECONDS_PER_SCHEDULING_DAY).nullable().default(0),
		fallback: z.enum(['truncate-left', 'reject-start']).default('truncate-left'),
	})
	.superRefine((boundary, context) => {
		if (boundary.maxDriftSeconds === null && boundary.policy !== 'finish-left') {
			context.addIssue({
				code: 'custom',
				path: ['maxDriftSeconds'],
				message: 'Unlimited drift is only valid when finishing the outgoing item',
			});
		}
	});
/** Shared wire contract for layer boundary. */
export type LayerBoundary = z.infer<typeof layerBoundarySchema>;

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
	}),
	exitBoundary: layerBoundarySchema.default({
		policy: 'hard',
		maxDriftSeconds: 0,
		fallback: 'truncate-left',
	}),
});
/** Shared wire contract for channel schedule layer. */
export type ChannelScheduleLayer = z.infer<typeof channelScheduleLayerSchema>;

/** Validate the channel schedule config contract at runtime. */
export const channelScheduleConfigSchema = z.object({
	defaultTemplateId: z.uuid(),
	layers: z.array(channelScheduleLayerSchema).max(MAX_CHANNEL_SCHEDULE_LAYERS).default([]),
	defaultFiller: fillerConfigSchema.nullable().default(null),
});
/** Shared wire contract for channel schedule config. */
export type ChannelScheduleConfig = z.infer<typeof channelScheduleConfigSchema>;

/** Shared wire contract for channel schedule. */
export interface ChannelSchedule extends ChannelScheduleConfig {
	channelId: string;
	createdAt: string;
	updatedAt: string;
}

/** Shared wire contract for selection state value. */
export type SelectionStateValue
	= | { type: 'sequential'; nextIndex: number; lastItemId: string | null }
		| {
			type: 'shuffle';
			cycle: number;
			cycleItemIds: string[];
			remainingItemIds: string[];
			lastItemId: string | null;
		}
		| { type: 'random'; counter: number; lastItemId: string | null }
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
	trackNumber?: number | null;
	discNumber?: number | null;
	multipartStatus?: 'none' | 'complete' | 'incomplete' | 'ambiguous';
	genres: string[];
	genreNames: string[];
	plot: string | null;
	year: number | null;
	artworkUrl: string | null;
	availability: MediaAvailability;
}

/** Shared wire contract for scheduling catalog. */
export interface SchedulingCatalog {
	media: SchedulableMedia[];
	/** In-process revision/scope identity used to avoid repeated worker transfers. */
	cacheKey?: string;
	/** Runtime indexes are optional on serialized/test catalogs and rebuilt at process boundaries. */
	mediaById?: ReadonlyMap<string, SchedulableMedia>;
	mediaByLibrary?: ReadonlyMap<string, SchedulableMedia[]>;
	mediaByGroup?: ReadonlyMap<string, SchedulableMedia[]>;
	mediaAliases?: Record<string, string>;
	groupParents: Record<string, string | null>;
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
	title: string;
	year: number | null;
	artworkUrl: string | null;
	availability: MediaAvailability;
}

/** Shared wire contract for scheduling program status. */
export interface SchedulingProgramStatus {
	programId: string;
	health: SchedulingProgramHealth;
	sourceLabel: string;
	indexedItemCount: number;
	availableItemCount: number;
	previewItems: SchedulingProgramPreviewItem[];
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
	id: string;
	role: 'primary' | 'filler' | 'dead-air';
	channelId: string;
	scheduleLayerId: string | null;
	templateId: string;
	slotId: string;
	programId: string | null;
	mediaItemId: string | null;
	title: string;
	playbackPath: string | null;
	playbackParts?: Array<{ playbackPath: string; durationSeconds: number }>;
	start: string;
	finish: string;
	sourceStartSeconds: number;
	sourceFinishSeconds: number | null;
	truncated: boolean;
}

/** Shared wire contract for timeline issue. */
export interface TimelineIssue {
	code: string;
	message: string;
	scheduleLayerId: string | null;
	templateId: string | null;
	slotId: string | null;
	programId: string | null;
	mediaItemId: string | null;
}

/** Shared wire contract for timeline preview. */
export interface TimelinePreview {
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
	channels: Array<{ channelId: string; preview: TimelinePreview }>;
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
