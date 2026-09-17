import { itemGuideEntry } from './projection.js';
import { createHash } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import {
	XMLTV_EPG_DAYS,
	MAX_XMLTV_DESCRIPTION_LENGTH,
	effectiveChannelTvgId,
	type GuideEntry,
	type Channel,
	type ScheduleGuide,
	type SchedulableMedia,
	type SchedulingCatalog,
	type TimelineSegment,
} from '@moirai/shared';
import { publicChannelLogoUrl } from '../artwork/channel-logo-url.js';
import { versionedPublicUrl } from '../routes/public-url.js';
import type { Repository } from '../repository/index.js';
import {
	readCommittedGuideAfterMaterializing,
	readCommittedScheduleGuide,
} from './schedule-guide.js';
import { currentTimestamp } from '../time.js';

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

/** Escape text for safe inclusion in XML content or attributes. */
function xmlText(value: string): string {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&apos;');
}

/** Serialize one simple XML element with optional attributes. */
function element(name: string, value: string, attributes = ''): string {
	return `    <${name}${attributes}>${xmlText(value)}</${name}>`;
}

/** Return the Moirai-owned identifier shared by XMLTV and the M3U playlist. */
export function effectiveTvgId(channel: Channel): string {
	return effectiveChannelTvgId(channel);
}

/** Format an instant using XMLTV local time and its per-instant UTC offset. */
export function xmltvTimestamp(value: string, timeZone: string): string {
	const zoned = Temporal.Instant.from(value).toZonedDateTimeISO(timeZone);
	const dateTime = [
		zoned.year.toString().padStart(4, '0'),
		zoned.month.toString().padStart(2, '0'),
		zoned.day.toString().padStart(2, '0'),
		zoned.hour.toString().padStart(2, '0'),
		zoned.minute.toString().padStart(2, '0'),
		zoned.second.toString().padStart(2, '0'),
	].join('');
	const offset = zoned.offset === '+00:00' ? '+0000' : zoned.offset.replace(':', '');
	return `${dateTime} ${offset}`;
}

/** Read a series title from the bounded segment metadata snapshot. */
function seriesTitle(media: SchedulableMedia, catalog: SchedulingCatalog): string | null {
	const snapshotTitle = (media as SchedulableMedia & { seriesTitle?: string }).seriesTitle;
	if (snapshotTitle) {
		return snapshotTitle;
	}

	if (media.kind !== 'episode' || !media.groupId) {
		return null;
	}

	const parentId = catalog.groupParents[media.groupId];
	return catalog.groupTitles[parentId ?? media.groupId] ?? null;
}

/** Serialize season and episode coordinates using XMLTV numbering. */
function episodeNumber(media: SchedulableMedia): string | null {
	if (media.seasonNumber === null && media.episodeNumber === null) {
		return null;
	}

	const season = media.seasonNumber === null ? '' : String(Math.max(0, media.seasonNumber - 1));
	const episode = media.episodeNumber === null ? '' : String(Math.max(0, media.episodeNumber - 1));
	return `${season}.${episode}.`;
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

/** Serialize one committed timeline segment as an XMLTV programme. */
function programmeXml(
	segment: TimelineSegment,
	channelId: string,
	mediaById: Map<string, SchedulableMedia>,
	catalog: SchedulingCatalog,
	publicUrl: string,
	timeZone: string,
): string[] {
	const media = segment.mediaItemId ? mediaById.get(segment.mediaItemId) : undefined;
	const showTitle = media ? seriesTitle(media, catalog) : null;
	const title = segment.role === 'dead-air' ? 'No programming' : showTitle || segment.title;
	const lines = [
		`  <programme start="${xmltvTimestamp(segment.start, timeZone)}" stop="${xmltvTimestamp(segment.finish, timeZone)}" channel="${xmlText(channelId)}">`,
		element('title', title),
	];
	if (showTitle && media) {
		lines.push(element('sub-title', media.title));
	}
	if (media?.plot) {
		lines.push(element('desc', media.plot.slice(0, MAX_XMLTV_DESCRIPTION_LENGTH)));
	}
	if (media?.year) {
		lines.push(element('date', String(media.year)));
	}
	for (const genre of media?.genreNames ?? []) {
		lines.push(element('category', genre));
	}
	if (segment.role === 'filler') {
		lines.push(element('category', 'Filler'));
	}
	if (segment.role === 'dead-air') {
		lines.push(element('category', 'No programming'));
	}
	if (media) {
		const number = episodeNumber(media);
		if (number) {
			lines.push(element('episode-num', number, ' system="xmltv_ns"'));
		}
		const sourceArtwork = media.artworkUrl
			? new URL(media.artworkUrl, `${publicUrl}/`)
			: null;
		const artworkVersion = sourceArtwork?.searchParams.get('v') ?? media.id;
		if (sourceArtwork) {
			sourceArtwork.searchParams.set('variant', 'compat');
			sourceArtwork.searchParams.set('dpr', '3');
		}
		const artwork = versionedPublicUrl(
			publicUrl,
			sourceArtwork?.toString() ?? null,
			artworkVersion,
		);
		if (artwork) {
			lines.push(`    <icon src="${xmlText(artwork)}" />`);
		}
	}
	lines.push('  </programme>');
	return lines;
}

/** Publish authored block metadata without borrowing a selected video's metadata. */
function blockProgrammeXml(entry: GuideEntry, channelId: string, timeZone: string): string[] {
	return [
		`  <programme start="${xmltvTimestamp(entry.start, timeZone)}" stop="${xmltvTimestamp(entry.finish, timeZone)}" channel="${xmlText(channelId)}">`,
		element('title', entry.title),
		...(entry.description ? [element('desc', entry.description)] : []),
		'  </programme>',
	];
}

/** Serialize committed channel timelines as an XMLTV document. */
export function buildXmltv(
	channels: Channel[],
	guide: ScheduleGuide,
	catalog: SchedulingCatalog,
	publicUrl: string,
): string {
	const sortedChannels = [...channels].sort((left, right) =>
		left.number.localeCompare(right.number, undefined, { numeric: true, sensitivity: 'base' }));
	const ids = new Set<string>();
	const lines = ['<?xml version="1.0" encoding="UTF-8"?>', '<tv generator-info-name="Moirai">'];
	for (const channel of sortedChannels) {
		const id = effectiveTvgId(channel);
		if (ids.has(id)) {
			throw new DuplicateTvgIdError(id);
		}

		ids.add(id);
		lines.push(`  <channel id="${xmlText(id)}">`);
		lines.push(element('display-name', `${channel.number} ${channel.name}`));
		lines.push(element('display-name', channel.number));
		lines.push(element('display-name', channel.name));
		const logo = publicChannelLogoUrl(channel, publicUrl);
		if (logo) {
			lines.push(`    <icon src="${xmlText(logo)}" />`);
		}
		lines.push('  </channel>');
	}

	const guideByChannel = new Map(
		guide.channels.map((entry) => [entry.channelId, entry]),
	);
	const mediaById = new Map(catalog.media.map((media) => [media.id, media]));
	for (const channel of sortedChannels) {
		const id = effectiveTvgId(channel);
		const channelGuide = guideByChannel.get(channel.id);
		const configuredSegments = channelGuide?.preview.segments;
		const segments = configuredSegments?.length
			? [...configuredSegments]
			: [noProgrammingSegment(channel.id, guide.startDate, guide.days, guide.timeZone)];
		segments.sort((left, right) => left.start.localeCompare(right.start));
		const byId = new Map(segments.map((segment) => [segment.id, segment]));
		for (const entry of channelGuide?.entries ?? segments.map(itemGuideEntry)) {
			if (entry.kind === 'block') {
				lines.push(...blockProgrammeXml(entry, id, guide.timeZone));
			}
			else {
				const segment = byId.get(entry.segmentId!);
				if (segment) {
					lines.push(...programmeXml({ ...segment, start: entry.start, finish: entry.finish }, id, mediaById, catalog, publicUrl, guide.timeZone));
				}
			}
		}
	}
	lines.push('</tv>', '');
	return lines.join('\n');
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
		const [channels, materialized] = await Promise.all([
			this.repository.listChannels(),
			readCommittedGuideAfterMaterializing(
				() => readCommittedScheduleGuide(
					this.repository,
					this.timeZone,
					startDate,
					XMLTV_EPG_DAYS,
					{ includeMediaCatalog: true },
				),
				this.ensureMaterialized,
			),
		]);
		const body = buildXmltv(channels, materialized.guide, materialized.catalog, this.publicUrl);
		return {
			body,
			etag: `"${createHash('sha256').update(body).digest('hex')}"`,
			startDate,
			generatedAt: currentTimestamp(),
		};
	}
}
