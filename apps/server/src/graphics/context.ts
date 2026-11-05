import {
	effectiveChannelTvgId, emptyGraphicsContext, emptyGraphicsMedia, graphicsTimeFormatter, MAX_GRAPHICS_UPCOMING,
	type Channel, type GraphicsAiring, type GraphicsContext, type GraphicsMedia, type SchedulableMedia,
	type SchedulingCatalog, type TimelineSegment,
} from '@moirai/shared';
import { renderGuideListing } from '../guide/listing.js';
import { itemGuideEntry } from '../guide/projection.js';
import { channelContext, compileGuideTemplate, seriesTitle, xmlProgrammeText } from '../guide/xmltv-template.js';
import type { Repository } from '../repository/index.js';
import type { GraphicsSegment } from './segments.js';

/** Represent the current airing and its lookahead without loading any catalog metadata. */
interface AiringReferences<T> {
	now: T | null;
	upcoming: T[];
}

/** Keep all physical splits of a primary airing under the same identity. */
function airingId(segment: GraphicsSegment): string {
	return segment.airing?.id ?? segment.id;
}

/** Resolve context across rolls and boundaries while keeping the next distinct main airings. */
function airingReferences<T extends GraphicsSegment>(segments: T[], anchors: T[] = []): Map<string, AiringReferences<T>> {
	const primary = new Map(anchors.map(item => [airingId(item), item]));
	for (const segment of segments) {
		if (segment.role === 'primary' && (!primary.has(airingId(segment)) || segment.id === segment.airing?.primarySegmentId)) {
			primary.set(airingId(segment), segment);
		}
	}

	const references = new Map<string, AiringReferences<T>>();
	const byAiring = new Map<string, AiringReferences<T>>();
	let future: T[] = [];
	for (let index = segments.length - 1; index >= 0; index--) {
		const segment = segments[index]!;
		if (segment.role === 'primary') {
			const id = airingId(segment);
			const main = primary.get(id)!;
			const reference = byAiring.get(id) ?? { now: main, upcoming: future.filter(item => airingId(item) !== id) };
			byAiring.set(id, reference);
			references.set(segment.id, reference);
			future = [main, ...reference.upcoming].slice(0, MAX_GRAPHICS_UPCOMING);
		}
		else if (segment.role === 'filler') {
			references.set(segment.id, { now: segment.airing ? primary.get(segment.airing.id) ?? null : null, upcoming: future });
		}
	}

	for (const segment of segments) {
		const attached = segment.role === 'filler' && segment.airing ? byAiring.get(segment.airing.id) : undefined;
		if (attached) {
			references.set(segment.id, attached);
		}
	}
	return references;
}

/** Expose raw catalog fields without any playback paths or internal identifiers. */
function rawMedia(segment: GraphicsSegment, media?: SchedulableMedia, catalog?: SchedulingCatalog): GraphicsMedia {
	return {
		...emptyGraphicsMedia,
		title: media?.title ?? null, subtitle: segment.subtitle ?? null, kind: media?.kind ?? null,
		seriesTitle: media && catalog ? seriesTitle(media, catalog) : null,
		seasonNumber: media?.seasonNumber ?? null, episodeNumber: media?.episodeNumber ?? null,
		episodeEndNumber: media?.episodeEndNumber ?? null, year: media?.year ?? null,
		releaseDate: media?.releaseDate ?? null, description: media?.plot ?? null, durationSeconds: media?.durationSeconds ?? null,
	};
}

/** Keep the full airing envelope independently of individual playout spans. */
function airingMetadata(segment: GraphicsSegment, formatter: Intl.DateTimeFormat, media: GraphicsMedia): GraphicsAiring {
	const start = segment.airing?.start ?? segment.start;
	return {
		title: segment.title, subtitle: null, start, finish: segment.airing?.finish ?? segment.finish,
		startTime: formatter.format(Date.parse(start)), media,
	};
}

/** Build a context from resolved metadata, keeping next identical to the first upcoming entry. */
function contextAt<T extends GraphicsSegment>(
	channel: Channel,
	segment: T,
	reference: AiringReferences<T>,
	media: (item: T) => GraphicsMedia,
	airing: (item: T) => GraphicsAiring,
): GraphicsContext {
	const upcoming = reference.upcoming.map(airing);
	return {
		...emptyGraphicsContext(channel), media: media(segment),
		now: reference.now ? airing(reference.now) : null, next: upcoming[0] ?? null, upcoming,
	};
}

/** Resolve schedule-only context for callers that have no guide metadata preparation. */
export function graphicsContexts(channel: Channel, segments: GraphicsSegment[], timeZone = 'UTC'): Map<string, GraphicsContext> {
	const formatter = graphicsTimeFormatter(timeZone);
	const references = airingReferences(segments);
	return new Map(segments.flatMap(segment => {
		const reference = references.get(segment.id);
		return reference ? [[segment.id, contextAt(
			channel,
			segment,
			reference,
			rawMedia,
			item => airingMetadata(item, formatter, rawMedia(item)),
		)]] : [];
	}));
}

/** Load missing primary segments without adding earlier airings to the playout lookahead. */
async function missingPrimaryAnchors(repository: Repository, channel: Channel, segments: TimelineSegment[], targets: TimelineSegment[]) {
	const present = new Set(segments.map(segment => segment.id));
	const missing = new Set(targets.flatMap(({ airing }) =>
		airing?.primarySegmentId && !present.has(airing.primarySegmentId) ? [airing.primarySegmentId] : []));
	return missing.size ? repository.listTimelinePrimaryAnchors(channel.id, [...missing]) : [];
}

/** Read only required metadata, favoring committed catalog values over later edits. */
async function loadMedia(repository: Repository, required: TimelineSegment[], hasTime: () => boolean) {
	const snapshots = await repository.timelineMediaSnapshots(required.map(item => item.id));
	if (!hasTime()) {
		return null;
	}
	// Guide templates can use current artwork. Read the needed IDs and their groups in one batch.
	const catalog = await repository.getSchedulingCatalogForItems(required.flatMap(item => item.mediaItemId ? [item.mediaItemId] : []));
	if (!hasTime()) {
		return null;
	}
	const current = new Map(catalog.media.map(item => [item.id, item]));
	const media = new Map<string, SchedulableMedia>();
	for (const item of required) {
		const snapshot = snapshots.get(item.id);
		const live = item.mediaItemId ? current.get(item.mediaItemId) : undefined;
		if (snapshot) {
			media.set(item.id, {
				...snapshot, artworkUrl: live?.artworkUrl ?? snapshot.artworkUrl,
				posterUrl: live?.posterUrl ?? snapshot.posterUrl ?? null,
				landscapeUrl: live?.landscapeUrl ?? snapshot.landscapeUrl ?? null,
				fanartUrl: live?.fanartUrl ?? snapshot.fanartUrl ?? null,
			});
		}
		else if (live) {
			media.set(item.id, live);
		}
	}
	return { catalog, media };
}

/** Bound metadata reads between playout deadline checks without querying per item. */
const GRAPHICS_CONTEXT_BATCH_SIZE = 32;

/** Prepare guide labels once per required airing, starting with the caller's highest priority item. */
export async function prepareGraphicsContexts(
	repository: Repository,
	channel: Channel,
	segments: TimelineSegment[],
	targets: TimelineSegment[],
	timeZone: string,
	publicUrl: string,
	remainingMs?: () => number,
): Promise<Map<string, GraphicsContext>> {
	const contexts = new Map<string, GraphicsContext>();
	const hasTime = (): boolean => !remainingMs || remainingMs() > 0;
	if (!targets.length || !hasTime()) {
		return contexts;
	}

	const anchors = await missingPrimaryAnchors(repository, channel, segments, targets);
	if (!hasTime()) {
		return contexts;
	}

	const references = airingReferences(segments, anchors);
	const sources = await repository.guideTemplates.sourcesForChannel(channel);
	if (!hasTime()) {
		return contexts;
	}
	const compiled = compileGuideTemplate(sources, { fallback: true });
	const formatter = graphicsTimeFormatter(timeZone);
	const guideChannel = channelContext(channel, publicUrl, effectiveChannelTvgId(channel));
	const airings = new Map<string, GraphicsAiring>();

	// Bound each catalog read and render the closest labels before loading more of the window.
	for (let offset = 0; offset < targets.length && hasTime(); offset += GRAPHICS_CONTEXT_BATCH_SIZE) {
		const batch = targets.slice(offset, offset + GRAPHICS_CONTEXT_BATCH_SIZE);
		const required = new Map(batch.map(item => [item.id, item]));
		for (const target of batch) {
			const reference = references.get(target.id);
			for (const item of [reference?.now, ...(reference?.upcoming ?? [])]) {
				if (item && !airings.has(airingId(item))) {
					required.set(item.id, item);
				}
			}
		}
		const loaded = await loadMedia(repository, [...required.values()], hasTime);
		if (!loaded) {
			break;
		}

		const { catalog, media } = loaded;
		const raw = (item: TimelineSegment): GraphicsMedia => rawMedia(item, media.get(item.id), catalog);
		for (const target of batch) {
			const reference = references.get(target.id);
			if (!reference) {
				continue;
			}

			for (const item of [reference.now, ...reference.upcoming]) {
				if (!item || airings.has(airingId(item))) {
					continue;
				}
				if (!hasTime()) {
					return contexts;
				}
				const airing = airingMetadata(item, formatter, raw(item));
				let listing;
				try {
					listing = await renderGuideListing(
						itemGuideEntry(item),
						item,
						media.get(item.id),
						catalog,
						guideChannel,
						timeZone,
						publicUrl,
						compiled,
						{ fallback: true, ...(remainingMs ? { remainingMs } : {}) },
					);
				}
				catch (error) {
					if (!hasTime()) {
						return contexts;
					}
					throw error;
				}
				if (listing) {
					const { title, subtitle } = xmlProgrammeText(listing.xml);
					airing.title = title || airing.title;
					airing.subtitle = subtitle || null;
				}
				airings.set(airingId(item), airing);
			}
			if (!hasTime()) {
				return contexts;
			}

			contexts.set(target.id, contextAt(channel, target, reference, raw, item => airings.get(airingId(item))!));
		}
	}
	return contexts;
}
