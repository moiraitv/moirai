import { Liquid, type Template } from 'liquidjs';
import {
	BUILTIN_GUIDE_TEMPLATE,
	GUIDE_TEMPLATE_SOURCE_KEYS,
	MAX_GUIDE_TEMPLATE_SOURCE_LENGTH,
	MAX_XMLTV_DESCRIPTION_LENGTH,
	resolvedGuideTemplateSources,
	type Channel,
	type GuideEntry,
	type GuideProgrammeKind,
	type GuideTemplateSourceKey,
	type GuideTemplateSources,
	type SchedulableMedia,
	type SchedulingCatalog,
	type TimelineSegment,
} from '@moirai/shared';
import { Temporal } from '@js-temporal/polyfill';
import { publicChannelLogoUrl } from '../artwork/channel-logo-url.js';
import { versionedPublicUrl } from '../routes/public-url.js';

/** Compiled Liquid documents for every XMLTV template tab. */
export interface CompiledGuideTemplate {
	sources: GuideTemplateSources;
	templates: Record<GuideTemplateSourceKey, Template[]>;
}

/** Optional diagnostics for a failed live fragment that fell back to the built-in source. */
export type GuideTemplateWarn = (message: string, extra?: Record<string, unknown>) => void;

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

/** Escape interpolated values so catalog text cannot inject XML markup. */
export function escapeXmlText(value: unknown): string {
	return String(value ?? '')
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&apos;');
}

/** Read the first matching element's text, reversing XML interpolation escapes. */
export function xmlChildText(xml: string, name: string): string {
	const match = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'u').exec(xml);
	if (!match) {
		return '';
	}

	return match[1]!
		.replaceAll('&lt;', '<')
		.replaceAll('&gt;', '>')
		.replaceAll('&quot;', '"')
		.replaceAll('&apos;', "'")
		.replaceAll('&amp;', '&')
		.trim();
}

/** Collapse insignificant whitespace between tags without changing text content. */
export function minifyXmltv(xml: string): string {
	return `${xml.replace(/>\s+</gu, '><').trim()}\n`;
}

/** Create a bounded Liquid engine without filesystem tags or host objects. */
function createEngine(): Liquid {
	const engine = new Liquid({
		strictVariables: true,
		strictFilters: true,
		lenientIf: true,
		ownPropertyOnly: true,
		parseLimit: MAX_GUIDE_TEMPLATE_SOURCE_LENGTH,
		renderLimit: 500,
		memoryLimit: 1_048_576,
		outputEscape: escapeXmlText,
	});
	for (const tag of ['include', 'render', 'layout']) {
		engine.registerTag(tag, {
			parse() {
				throw new Error('File-loading template tags are disabled');
			},
			render() {
				return '';
			},
		});
	}

	return engine;
}

const engine = createEngine();

/** Parse one tab, falling back to the built-in source when live XMLTV cannot use the authored source. */
function parseKind(
	source: string,
	key: GuideTemplateSourceKey,
	fallback: boolean,
	warn?: GuideTemplateWarn,
): Template[] {
	const authored = source.trim();
	const candidate = authored || BUILTIN_GUIDE_TEMPLATE.sources[key];
	try {
		return engine.parse(candidate);
	}
	catch (cause) {
		if (!fallback) {
			throw cause instanceof Error ? cause : new Error(String(cause));
		}

		warn?.('Guide template source failed to parse; using the built-in layout', {
			key,
			error: cause instanceof Error ? cause.message : String(cause),
		});
		return engine.parse(BUILTIN_GUIDE_TEMPLATE.sources[key]);
	}
}

/**
 * Parse every tab once per document. Preview rejects invalid Liquid; live XMLTV falls back
 * per tab to the built-in source.
 */
export function compileGuideTemplate(
	sources: GuideTemplateSources,
	options: { fallback: boolean; warn?: GuideTemplateWarn } = { fallback: false },
): CompiledGuideTemplate {
	const resolved = options.fallback ? resolvedGuideTemplateSources(sources) : sources;
	const templates = {} as Record<GuideTemplateSourceKey, Template[]>;
	for (const key of GUIDE_TEMPLATE_SOURCE_KEYS) {
		templates[key] = parseKind(resolved[key], key, options.fallback, options.warn);
	}

	return { sources: resolved, templates };
}

/** Channel identity used when validating or rendering a `<channel>` fragment. */
const VALIDATION_CHANNEL = {
	id: 'C1.example.moirai.tv',
	number: '1',
	name: 'Example',
	logo_url: null,
};

/** Representative media object used when validating programme tabs that list an item. */
const VALIDATION_ITEM = {
	id: '00000000-0000-4000-8000-000000000001',
	kind: 'episode',
	title: 'Episode',
	sort_title: 'episode',
	duration_seconds: 3600,
	season_number: 1,
	episode_number: 1,
	episode_end_number: null,
	artists: [],
	artist_names: [],
	album_names: [],
	track_number: null,
	disc_number: null,
	genres: [],
	genre_names: ['Drama'],
	plot: 'Plot',
	year: 2026,
	release_date: '2026-01-01',
	date_added_at: null,
	rating: null,
	user_rating: null,
	actors: [],
	directors: [],
	artwork_url: null,
	availability: 'available',
	show_title: 'Show',
	xmltv_episode_num: '0.0.',
};

/** Build the same Liquid context a live render will pass for one template tab. */
function validationContextFor(key: GuideTemplateSourceKey): Record<string, unknown> {
	if (key === 'channel') {
		return { channel: VALIDATION_CHANNEL };
	}

	const item = key === 'dead-air' || key === 'block'
		? null
		: { ...VALIDATION_ITEM, kind: key === 'filler' ? 'movie' : key };
	return {
		kind: key,
		title: 'Title',
		start: '20260101000000 +0000',
		stop: '20260101010000 +0000',
		start_iso: '2026-01-01T00:00:00Z',
		stop_iso: '2026-01-01T01:00:00Z',
		channel: VALIDATION_CHANNEL,
		item,
		slot: {
			start: '2026-01-01T00:00:00Z',
			finish: '2026-01-01T01:00:00Z',
			role: key === 'filler' || key === 'dead-air' ? key : 'primary',
			title: 'Title',
			program_id: null,
			truncated: false,
		},
		block: key === 'block' ? { title: 'Block', description: 'Description' } : null,
	};
}

/** Validate authored sources by parsing and rendering each non-empty tab. */
export async function validateGuideTemplateSources(sources: GuideTemplateSources): Promise<void> {
	for (const key of GUIDE_TEMPLATE_SOURCE_KEYS) {
		const source = sources[key];
		if (source.trim()) {
			await engine.parseAndRender(source, validationContextFor(key));
		}
	}
}

/** Read a series title from a bounded segment snapshot or catalog groups. */
export function seriesTitle(media: SchedulableMedia, catalog: SchedulingCatalog): string | null {
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
export function xmltvEpisodeNumber(media: SchedulableMedia): string | null {
	if (media.seasonNumber === null && media.episodeNumber === null) {
		return null;
	}

	const season = media.seasonNumber === null ? '' : String(Math.max(0, media.seasonNumber - 1));
	const episode = media.episodeNumber === null ? '' : String(Math.max(0, media.episodeNumber - 1));
	return `${season}.${episode}.`;
}

/** Choose the programme tab for a listing, preferring gap roles over media kind. */
export function programmeKind(
	entry: GuideEntry,
	segment: TimelineSegment | undefined,
	media: SchedulableMedia | undefined,
): GuideProgrammeKind {
	if (entry.kind === 'block') {
		return 'block';
	}
	if (segment?.role === 'dead-air' || entry.role === 'dead-air') {
		return 'dead-air';
	}
	if (segment?.role === 'filler' || entry.role === 'filler') {
		return 'filler';
	}
	if (media?.kind === 'episode') {
		return 'episode';
	}
	if (media?.kind === 'movie') {
		return 'movie';
	}
	if (media?.kind === 'music-video') {
		return 'music-video';
	}

	return 'other';
}

/** Build the versioned public artwork URL used by the standard XMLTV layout. */
function itemArtworkUrl(
	media: SchedulableMedia,
	publicUrl: string,
): string | null {
	const sourceArtwork = media.artworkUrl
		? new URL(media.artworkUrl, `${publicUrl}/`)
		: null;
	const artworkVersion = sourceArtwork?.searchParams.get('v') ?? media.id;
	if (sourceArtwork) {
		sourceArtwork.searchParams.set('variant', 'compat');
		sourceArtwork.searchParams.set('dpr', '3');
	}

	return versionedPublicUrl(
		publicUrl,
		sourceArtwork?.toString() ?? null,
		artworkVersion,
	);
}

/** Flatten schedulable media into a complete Liquid object with nulls, not missing keys. */
function itemContext(
	media: SchedulableMedia | undefined,
	catalog: SchedulingCatalog,
	publicUrl: string,
): Record<string, unknown> | null {
	if (!media) {
		return null;
	}

	const plot = media.plot ? media.plot.slice(0, MAX_XMLTV_DESCRIPTION_LENGTH) : null;
	return {
		id: media.id,
		kind: media.kind,
		title: media.title,
		sort_title: media.sortTitle,
		duration_seconds: media.durationSeconds,
		season_number: media.seasonNumber,
		episode_number: media.episodeNumber,
		episode_end_number: media.episodeEndNumber ?? null,
		artists: media.artists ?? [],
		artist_names: media.artistNames ?? [],
		album_names: media.albumNames ?? [],
		track_number: media.trackNumber ?? null,
		disc_number: media.discNumber ?? null,
		genres: media.genres,
		genre_names: media.genreNames,
		plot,
		year: media.year,
		release_date: media.releaseDate ?? null,
		date_added_at: media.dateAddedAt ?? null,
		rating: media.rating ?? null,
		user_rating: media.userRating ?? null,
		actors: media.actors ?? [],
		directors: media.directors ?? [],
		artwork_url: itemArtworkUrl(media, publicUrl),
		availability: media.availability,
		show_title: seriesTitle(media, catalog),
		xmltv_episode_num: xmltvEpisodeNumber(media),
	};
}

/** Channel identity presented to both channel and programme templates. */
export function channelContext(channel: Channel, publicUrl: string, tvgId: string): Record<string, unknown> {
	return {
		id: tvgId,
		number: channel.number,
		name: channel.name,
		logo_url: publicChannelLogoUrl(channel, publicUrl),
	};
}

/** Complete programme render context for one listing. */
export function programmeContext(input: {
	kind: GuideProgrammeKind;
	title: string;
	start: string;
	finish: string;
	timeZone: string;
	channel: Record<string, unknown>;
	item: Record<string, unknown> | null;
	slot: {
		start: string;
		finish: string;
		role: string;
		title: string;
		program_id: string | null;
		truncated: boolean;
	};
	block: { title: string; description: string } | null;
}): Record<string, unknown> {
	return {
		kind: input.kind,
		title: input.title,
		start: xmltvTimestamp(input.start, input.timeZone),
		stop: xmltvTimestamp(input.finish, input.timeZone),
		start_iso: input.start,
		stop_iso: input.finish,
		channel: input.channel,
		item: input.item,
		slot: input.slot,
		block: input.block,
	};
}

/** Format a resolved Liquid value for the template-editor inspector. */
function formatLiquidPreviewValue(value: unknown): string {
	if (value === null) {
		return 'null';
	}
	if (value === undefined) {
		return 'undefined';
	}
	if (value === '') {
		return '""';
	}
	if (typeof value === 'boolean' || typeof value === 'number') {
		return String(value);
	}

	return String(value);
}

/**
 * Flatten a complete Liquid context into dotted names matching the built-in help comments.
 */
export function flattenLiquidPreviewValues(root: Record<string, unknown>): Array<{ name: string; value: string }> {
	const rows: Array<{ name: string; value: string }> = [];
	const walk = (prefix: string, value: unknown): void => {
		if (value === null || value === undefined || typeof value !== 'object') {
			rows.push({ name: prefix, value: formatLiquidPreviewValue(value) });
			return;
		}
		if (Array.isArray(value)) {
			if (value.length === 0 || value.every((entry) => entry === null || typeof entry !== 'object')) {
				rows.push({
					name: prefix,
					value: value.length === 0 ? '[]' : value.map((entry) => formatLiquidPreviewValue(entry)).join(', '),
				});
				return;
			}

			value.forEach((entry, index) => {
				walk(`${prefix}[${index}]`, entry);
			});
			return;
		}

		const entries = Object.entries(value);
		if (!prefix) {
			for (const [key, child] of entries) {
				walk(key, child);
			}
			return;
		}
		if (entries.length === 0) {
			rows.push({ name: prefix, value: '{}' });
			return;
		}
		for (const [key, child] of entries) {
			walk(`${prefix}.${key}`, child);
		}
	};

	walk('', root);
	return rows;
}

/** Drop surrounding blank lines without removing the fragment's leading indent. */
function normalizeFragment(value: string): string {
	return value.replace(/^\n+/u, '').replace(/\s+$/u, '');
}

/** Render one compiled tab and trim surrounding blank lines. */
async function renderTab(
	compiled: CompiledGuideTemplate,
	key: GuideTemplateSourceKey,
	context: Record<string, unknown>,
	options: { fallback: boolean; warn?: GuideTemplateWarn },
): Promise<string> {
	try {
		return normalizeFragment(String(await engine.render(compiled.templates[key], context)));
	}
	catch (cause) {
		if (!options.fallback) {
			throw cause instanceof Error ? cause : new Error(String(cause));
		}

		options.warn?.('Guide template render failed; using the built-in layout', {
			key,
			error: cause instanceof Error ? cause.message : String(cause),
		});
		const builtin = engine.parse(BUILTIN_GUIDE_TEMPLATE.sources[key]);
		return normalizeFragment(String(await engine.render(builtin, context)));
	}
}

/** Render the XMLTV channel fragment for one channel. */
export async function renderChannelFragment(
	compiled: CompiledGuideTemplate,
	context: Record<string, unknown>,
	options: { fallback: boolean; warn?: GuideTemplateWarn } = { fallback: false },
): Promise<string> {
	return renderTab(compiled, 'channel', context, options);
}

/** Render one XMLTV programme fragment. */
export async function renderProgrammeFragment(
	compiled: CompiledGuideTemplate,
	kind: GuideProgrammeKind,
	context: Record<string, unknown>,
	options: { fallback: boolean; warn?: GuideTemplateWarn } = { fallback: false },
): Promise<string> {
	return renderTab(compiled, kind, context, options);
}

/** Build the listing title used by the standard XMLTV layout. */
export function listingTitle(
	kind: GuideProgrammeKind,
	entry: GuideEntry,
	segment: TimelineSegment | undefined,
	media: SchedulableMedia | undefined,
	catalog: SchedulingCatalog,
): string {
	if (kind === 'dead-air') {
		return 'No programming';
	}
	if (kind === 'block') {
		return entry.title;
	}

	const showTitle = media ? seriesTitle(media, catalog) : null;
	return showTitle || segment?.title || entry.title;
}

/** Assemble a complete item context for a programme listing. */
export function mediaItemContext(
	media: SchedulableMedia | undefined,
	catalog: SchedulingCatalog,
	publicUrl: string,
): Record<string, unknown> | null {
	return itemContext(media, catalog, publicUrl);
}
