import type { SchedulingWorkerPool } from '../scheduling/worker-pool.js';
import { itemGuideEntry } from './projection.js';
import { createHash } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import {
	XMLTV_EPG_DAYS,
	effectiveChannelTvgId,
	type Channel,
	type GuideEntry,
	type GuideTemplatePreviewValue,
	type GuideTemplateSources,
	type ScheduleGuide,
	type SchedulableMedia,
	type SchedulingCatalog,
	type TimelineSegment,
} from '@moirai/shared';
import type { Repository } from '../repository/index.js';
import {
	readCommittedGuideAfterMaterializing,
	readCommittedScheduleGuide,
} from './schedule-guide.js';
import { currentTimestamp } from '../time.js';
import {
	channelContext,
	compileGuideTemplate,
	flattenLiquidPreviewValues,
	listingTitle,
	mediaItemContext,
	minifyXmltv,
	programmeContext,
	programmeKind,
	renderChannelFragment,
	renderProgrammeFragment,
	xmlChildText,
	xmltvTimestamp,
	type CompiledGuideTemplate,
	type GuideTemplateWarn,
} from './xmltv-template.js';

export { xmltvTimestamp, minifyXmltv };

/** XMLTV document with its covered time window and channel count. */
export interface EpgDocument {
	body: string;
	etag: string;
	startDate: string;
	generatedAt: string;
}

/** Report channel identifiers that would make the XMLTV document ambiguous. */
export class DuplicateTvgIdError extends Error {
	constructor(readonly tvgId: string) {
		super(`Multiple channels use the XMLTV identifier "${tvgId}"`);
		this.name = 'DuplicateTvgIdError';
	}
}

/** Return the Moirai-owned identifier shared by XMLTV and the M3U playlist. */
export function effectiveTvgId(channel: Channel): string {
	return effectiveChannelTvgId(channel);
}

/** Create a bounded placeholder programme for an explicit guide gap. */
function noProgrammingSegment(
	channelId: string,
	startDate: string,
	days: number,
	timeZone: string,
): TimelineSegment {
	const start = Temporal.PlainDate.from(startDate).toZonedDateTime(timeZone).toInstant();
	const finish = Temporal.PlainDate.from(startDate)
		.add({ days })
		.toZonedDateTime(timeZone)
		.toInstant();
	return {
		id: `no-programming-${channelId}-${startDate}`,
		role: 'dead-air',
		channelId,
		scheduleLayerId: null,
		templateId: channelId,
		slotId: channelId,
		programId: null,
		mediaItemId: null,
		title: 'No programming',
		playbackPath: null,
		playbackParts: [],
		start: start.toString(),
		finish: finish.toString(),
		sourceStartSeconds: 0,
		sourceFinishSeconds: null,
		truncated: false,
	};
}

/** Options that select compiled sources and whether to minify the published document. */
export interface BuildXmltvOptions {
	sourcesForChannel: (channel: Channel) => GuideTemplateSources;
	minify?: boolean;
	fallback?: boolean;
	warn?: GuideTemplateWarn;
}

/** Compile a template once and reuse it for every listing that shares those sources. */
function compiledForSources(
	cache: Map<string, CompiledGuideTemplate>,
	sources: GuideTemplateSources,
	options: { fallback: boolean; warn?: GuideTemplateWarn },
): CompiledGuideTemplate {
	const cacheKey = JSON.stringify(sources);
	const existing = cache.get(cacheKey);
	if (existing) {
		return existing;
	}

	const compiled = compileGuideTemplate(sources, options.warn
		? { fallback: options.fallback, warn: options.warn }
		: { fallback: options.fallback });
	cache.set(cacheKey, compiled);
	return compiled;
}

/** Render one channel's listings with the compiled template for each programme kind. */
async function renderChannelListings(
	channel: Channel,
	guide: ScheduleGuide,
	catalog: SchedulingCatalog,
	publicUrl: string,
	compiled: CompiledGuideTemplate,
	mediaById: Map<string, SchedulingCatalog['media'][number]>,
	renderOptions: { fallback: boolean; warn?: GuideTemplateWarn },
): Promise<Array<{ entry: GuideEntry; xml: string; context: Record<string, unknown> }>> {
	const id = effectiveTvgId(channel);
	const channelGuide = new Map(guide.channels.map((entry) => [entry.channelId, entry])).get(channel.id);
	const configuredSegments = channelGuide?.preview.segments;
	const segments = configuredSegments?.length
		? [...configuredSegments]
		: [noProgrammingSegment(channel.id, guide.startDate, guide.days, guide.timeZone)];
	segments.sort((left, right) => left.start.localeCompare(right.start));
	const byId = new Map(segments.map((segment) => [segment.id, segment]));
	const contextChannel = channelContext(channel, publicUrl, id);
	const listings: Array<{ entry: GuideEntry; xml: string; context: Record<string, unknown> }> = [];
	for (const entry of channelGuide?.entries ?? segments.map(itemGuideEntry)) {
		const segment = entry.segmentId ? byId.get(entry.segmentId) : undefined;
		const timedSegment = segment
			? { ...segment, start: entry.start, finish: entry.finish }
			: undefined;
		const media = timedSegment?.mediaItemId ? mediaById.get(timedSegment.mediaItemId) : undefined;
		const kind = programmeKind(entry, timedSegment, media);
		if (kind !== 'block' && !timedSegment) {
			continue;
		}

		const start = timedSegment?.start ?? entry.start;
		const finish = timedSegment?.finish ?? entry.finish;
		const context = programmeContext({
			kind,
			title: listingTitle(kind, entry, timedSegment, media, catalog),
			start,
			finish,
			timeZone: guide.timeZone,
			channel: contextChannel,
			item: mediaItemContext(media, catalog, publicUrl),
			slot: {
				start,
				finish,
				role: timedSegment?.role ?? entry.role,
				title: timedSegment?.title ?? entry.title,
				program_id: timedSegment?.programId ?? entry.programId,
				truncated: timedSegment?.truncated ?? entry.truncated,
			},
			block: kind === 'block'
				? { title: entry.title, description: entry.description }
				: null,
		});
		const xml = await renderProgrammeFragment(compiled, kind, context, renderOptions);
		listings.push({ entry, xml, context });
	}

	return listings;
}

/** Serialize committed channel timelines as an XMLTV document. */
export async function buildXmltv(
	channels: Channel[],
	guide: ScheduleGuide,
	catalog: SchedulingCatalog,
	publicUrl: string,
	options: BuildXmltvOptions,
): Promise<string> {
	const sortedChannels = [...channels].sort((left, right) =>
		left.number.localeCompare(right.number, undefined, { numeric: true, sensitivity: 'base' }));
	const ids = new Set<string>();
	const lines = ['<?xml version="1.0" encoding="UTF-8"?>', '<tv generator-info-name="Moirai">'];
	const compiledBySources = new Map<string, CompiledGuideTemplate>();
	const fallback = options.fallback ?? false;
	const renderOptions = options.warn ? { fallback, warn: options.warn } : { fallback };

	for (const channel of sortedChannels) {
		const id = effectiveTvgId(channel);
		if (ids.has(id)) {
			throw new DuplicateTvgIdError(id);
		}

		ids.add(id);
		const compiled = compiledForSources(
			compiledBySources,
			options.sourcesForChannel(channel),
			renderOptions,
		);
		const fragment = await renderChannelFragment(
			compiled,
			{ channel: channelContext(channel, publicUrl, id) },
			renderOptions,
		);
		if (fragment) {
			lines.push(fragment);
		}
	}

	const mediaById = new Map(catalog.media.map((media) => [media.id, media]));
	for (const channel of sortedChannels) {
		const compiled = compiledForSources(
			compiledBySources,
			options.sourcesForChannel(channel),
			renderOptions,
		);
		for (const listing of await renderChannelListings(
			channel,
			guide,
			catalog,
			publicUrl,
			compiled,
			mediaById,
			renderOptions,
		)) {
			if (listing.xml) {
				lines.push(listing.xml);
			}
		}
	}
	lines.push('</tv>', '');
	const body = lines.join('\n');
	return options.minify ? minifyXmltv(body) : body;
}

/** Render one formatted local day using unpublished template sources. */
export async function previewGuideXmltv(
	channel: Channel,
	guide: ScheduleGuide,
	catalog: SchedulingCatalog,
	publicUrl: string,
	sources: GuideTemplateSources,
): Promise<string> {
	return buildXmltv([channel], guide, catalog, publicUrl, {
		sourcesForChannel: () => sources,
		minify: false,
		fallback: false,
	});
}

/** Copy catalog artwork onto a listing, using primary artwork when role URLs are absent. */
function listingArtwork(media?: SchedulableMedia): {
	posterUrl: string | null;
	landscapeUrl: string | null;
	fanartUrl: string | null;
} {
	return {
		posterUrl: media?.posterUrl ?? media?.artworkUrl ?? null,
		landscapeUrl: media?.landscapeUrl ?? null,
		fanartUrl: media?.fanartUrl ?? null,
	};
}

/** Copy XMLTV title and description onto a guide listing without mutating the source entry. */
function presentedEntry(entry: GuideEntry, xml: string, media?: SchedulableMedia): GuideEntry {
	return {
		...entry,
		title: xmlChildText(xml, 'title') || entry.title,
		subtitle: xmlChildText(xml, 'sub-title'),
		description: xmlChildText(xml, 'desc') || entry.description,
		...listingArtwork(media),
	};
}

/**
 * Replace displayed listing titles with the XMLTV output of each channel's guide template.
 * Returns a new guide object so the committed-guide cache is not mutated.
 */
export async function presentGuideListings(
	channels: Channel[],
	guide: ScheduleGuide,
	catalog: SchedulingCatalog,
	publicUrl: string,
	options: BuildXmltvOptions,
): Promise<ScheduleGuide> {
	const compiledBySources = new Map<string, CompiledGuideTemplate>();
	const mediaById = new Map(catalog.media.map((media) => [media.id, media]));
	const channelsById = new Map(channels.map((channel) => [channel.id, channel]));
	const fallback = options.fallback ?? false;
	const renderOptions = options.warn ? { fallback, warn: options.warn } : { fallback };
	const presented = await Promise.all(guide.channels.map(async (channelGuide) => {
		const channel = channelsById.get(channelGuide.channelId);
		if (!channel) {
			return channelGuide;
		}

		const listings = await renderChannelListings(
			channel,
			guide,
			catalog,
			publicUrl,
			compiledForSources(
				compiledBySources,
				options.sourcesForChannel(channel),
				renderOptions,
			),
			mediaById,
			renderOptions,
		);
		const byEntryId = new Map(listings.map((listing) => [listing.entry.id, listing]));
		const bySegmentId = new Map(
			listings.flatMap((listing) => listing.entry.segmentId
				? [[listing.entry.segmentId, listing] as const]
				: []),
		);
		const mediaForSegment = (segment: TimelineSegment | undefined): SchedulableMedia | undefined => (
			segment?.mediaItemId ? mediaById.get(segment.mediaItemId) : undefined
		);
		const segmentById = new Map(channelGuide.preview.segments.map((segment) => [segment.id, segment]));
		const entries = channelGuide.entries?.map((entry) => {
			const listing = byEntryId.get(entry.id);
			const segment = entry.segmentId ? segmentById.get(entry.segmentId) : undefined;
			return listing ? presentedEntry(entry, listing.xml, mediaForSegment(segment)) : entry;
		});
		return {
			...channelGuide,
			...(entries ? { entries } : {}),
			preview: {
				...channelGuide.preview,
				segments: channelGuide.preview.segments.map((segment) => {
					const listing = bySegmentId.get(segment.id) ?? byEntryId.get(segment.id);
					if (!listing) {
						return segment;
					}

					const media = mediaForSegment(segment);
					return {
						...segment,
						title: xmlChildText(listing.xml, 'title') || segment.title,
						subtitle: xmlChildText(listing.xml, 'sub-title'),
						...listingArtwork(media),
					};
				}),
			},
		};
	}));

	return { ...guide, channels: presented };
}

/** Overlay XMLTV titles onto one channel day and expose resolved Liquid values. */
export async function previewGuideListings(
	channel: Channel,
	guide: ScheduleGuide,
	catalog: SchedulingCatalog,
	publicUrl: string,
	sources: GuideTemplateSources,
): Promise<{
	entries: GuideEntry[];
	channelValues: GuideTemplatePreviewValue[];
	listingValues: Record<string, GuideTemplatePreviewValue[]>;
}> {
	const compiled = compileGuideTemplate(sources, { fallback: false });
	const mediaById = new Map(catalog.media.map((media) => [media.id, media]));
	const listings = await renderChannelListings(
		channel,
		guide,
		catalog,
		publicUrl,
		compiled,
		mediaById,
		{ fallback: false },
	);
	const listingValues: Record<string, GuideTemplatePreviewValue[]> = {};
	const segmentsById = new Map(
		(guide.channels.find((entry) => entry.channelId === channel.id)?.preview.segments ?? [])
			.map((segment) => [segment.id, segment]),
	);
	const entries = listings.map(({ entry, xml, context }) => {
		const segment = entry.segmentId ? segmentsById.get(entry.segmentId) : undefined;
		const media = segment?.mediaItemId ? mediaById.get(segment.mediaItemId) : undefined;
		const previewEntry = {
			...presentedEntry(entry, xml, media),
			segmentId: entry.segmentId && /^[0-9a-f-]{36}$/iu.test(entry.segmentId) ? entry.segmentId : null,
		};
		listingValues[previewEntry.id] = flattenLiquidPreviewValues(context);
		return previewEntry;
	});
	return {
		entries,
		channelValues: flattenLiquidPreviewValues({
			channel: channelContext(channel, publicUrl, effectiveTvgId(channel)),
		}),
		listingValues,
	};
}

/**
 * Produce the XMLTV feed from committed authoritative guide data. The service ensures timelines are
 * materialized, caches one deterministic daily document, coalesces concurrent IPTV-client requests,
 * and invalidates output after programming changes.
 */
export class EpgService {
	private cache: EpgDocument | null = null;
	private active: Promise<EpgDocument> | null = null;
	private revision = 0;

	constructor(
		private readonly repository: Repository,
		private readonly timeZone: string,
		private readonly publicUrl: string,
		private readonly ensureMaterialized: () => Promise<void> = async () => undefined,
		private readonly warn: GuideTemplateWarn = () => undefined,
		private readonly workers?: SchedulingWorkerPool,
		private readonly guideDays = XMLTV_EPG_DAYS,
	) {}

	/** Discard the cached XMLTV document after programming changes. */
	invalidate(): void {
		this.revision += 1;
		this.cache = null;
	}

	/** Return the current XMLTV document, coalescing concurrent regeneration. */
	async document(): Promise<EpgDocument> {
		const startDate = Temporal.Now.plainDateISO(this.timeZone).toString();
		if (this.cache?.startDate === startDate) {
			return this.cache;
		}

		if (this.active) {
			return this.active;
		}

		const revision = this.revision;
		this.active = this.generate(startDate);
		try {
			const document = await this.active;
			if (revision === this.revision) {
				this.cache = document;
			}
			return document;
		}
		finally {
			this.active = null;
		}
	}

	/** Generate the XMLTV model for the configured guide window. */
	private async generate(startDate: string): Promise<EpgDocument> {
		if (this.workers) {
			const result = await readCommittedGuideAfterMaterializing(() => this.workers!.read({ kind: 'xmltv', timeZone: this.timeZone, publicUrl: this.publicUrl,
				startDate, days: this.guideDays, guideDays: this.guideDays }), this.ensureMaterialized);
			result.warnings?.forEach(warning => this.warn(warning.message, warning.extra));
			return { body: result.body, etag: result.etag!, startDate: result.startDate!, generatedAt: result.generatedAt! };
		}

		const [channels, materialized] = await Promise.all([
			this.repository.listChannels(),
			readCommittedGuideAfterMaterializing(
				() => readCommittedScheduleGuide(
					this.repository,
					this.timeZone,
					startDate,
					this.guideDays,
					{ includeMediaCatalog: true, guideDays: this.guideDays },
				),
				this.ensureMaterialized,
			),
		]);
		const templates = await this.repository.guideTemplates.sourcesById();
		const body = await buildXmltv(
			channels.filter(channel => channel.enabled !== false),
			materialized.guide,
			materialized.catalog,
			this.publicUrl,
			{
				sourcesForChannel: (channel) => (
					channel.guideTemplateId
						? templates.byId.get(channel.guideTemplateId) ?? templates.defaultSources
						: templates.defaultSources
				),
				minify: true,
				fallback: true,
				warn: this.warn,
			},
		);
		return {
			body,
			etag: `"${createHash('sha256').update(body).digest('hex')}"`,
			startDate,
			generatedAt: currentTimestamp(),
		};
	}
}
