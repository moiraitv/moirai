import { z } from 'zod';
import { programTemplateContextSchema } from './program-metadata.js';

/** How a scheduling scope modifies its inherited graphics stack. */
export const graphicsAssignmentSchema = z.discriminatedUnion('mode', [
	z.object({ mode: z.literal('inherit') }).strict(),
	z.object({ mode: z.literal('off') }).strict(),
	z.object({ mode: z.literal('add'), presetId: z.uuid() }).strict(),
	z.object({ mode: z.literal('replace'), presetId: z.uuid() }).strict(),
]);

/** A scheduling scope's optional override of inherited graphics. */
export type GraphicsAssignment = z.infer<typeof graphicsAssignmentSchema>;

/** Anchors accepted by the pinned playout engine. */
export const graphicsAnchors = ['top_left', 'top_center', 'top_right', 'center_left', 'center', 'center_right', 'bottom_left', 'bottom_center', 'bottom_right'] as const;

/** IDs of the protected, bundled examples. */
export const graphicsExampleIds = [
	'2cd52ff4-16dc-4349-9000-166b643d1001',
	'2cd52ff4-16dc-4349-9000-166b643d1002',
	'2cd52ff4-16dc-4349-9000-166b643d1003',
	'2cd52ff4-16dc-4349-9000-166b643d1004',
	'2cd52ff4-16dc-4349-9000-166b643d1005',
	'2cd52ff4-16dc-4349-9000-166b643d1006',
] as const;

/** The visual editor's percentage domain. */
const percent = z.number().min(0).max(100);
/** Bounded milliseconds accepted from an author. */
const milliseconds = z.number().int().min(0).max(86_400_000);
/** A positive fade avoids FFmpeg's default frame-count fade for zero duration. */
export const MIN_GRAPHICS_FADE_MS = 1;

/** An installed graphics font and its bounded styling controls. */
const style = z.object({
	fontId: z.uuid().optional(),
	size: z.number().int().min(8).max(192),
	color: z.string().regex(/^#[0-9a-f]{6}$/i),
	bold: z.boolean().optional(),
	italic: z.boolean().optional(),
}).strict();
/** Maximum length of a layer name in the editor and YAML. */
export const MAX_GRAPHICS_LAYER_NAME_LENGTH = 80;
/** Maximum number of layers in one graphics preset. */
export const MAX_GRAPHICS_LAYERS = 8;

/** Fields shared by all graphics layers. */
const common = {
	id: z.uuid(),
	name: z.string().trim().min(1).max(MAX_GRAPHICS_LAYER_NAME_LENGTH).optional(),
	anchor: z.enum(graphicsAnchors),
	rotation: z.number().min(-180).max(180).optional(),
	attachment: z.object({
		layerId: z.uuid(),
		anchor: z.enum(graphicsAnchors),
		offsetX: z.number().min(-100).max(100),
		offsetY: z.number().min(-100).max(100),
	}).strict().optional(),
	horizontalMargin: percent,
	verticalMargin: percent,
	width: percent.min(1).optional(),
	opacity: percent,
	withinSource: z.boolean(),
	timing: z.discriminatedUnion('mode', [
		z.object({ mode: z.literal('always') }).strict(),
		z.object({ mode: z.literal('once'), phase: milliseconds, fade: milliseconds.min(MIN_GRAPHICS_FADE_MS), hold: milliseconds }).strict(),
		z.object({
			mode: z.literal('periodic'), clock: z.enum(['content', 'wall']), frequency: milliseconds.min(1),
			phase: milliseconds, fade: milliseconds.min(MIN_GRAPHICS_FADE_MS), hold: milliseconds, cutoff: milliseconds.min(1).optional(),
		}).strict(),
	]),
};

/** Shape primitives supported by the visual editor and rasterizer. */
export const graphicsShapes = ['rectangle', 'roundedRectangle', 'ellipse', 'line'] as const;

/** Color and independent alpha at one endpoint of a shape gradient. */
const gradientStop = z.object({
	color: z.string().regex(/^#[0-9a-f]{6}$/i),
	opacity: z.number().min(0).max(100),
}).strict();

/** Two-stop linear fill with a clockwise angle measured from up. */
const shapeGradient = z.object({
	angle: z.number().min(0).max(360),
	start: gradientStop,
	end: gradientStop,
}).strict();

/** Bounded vector geometry in pixels, before native layer scaling. */
const shape = z.object({
	primitive: z.enum(graphicsShapes),
	skewX: z.number().min(-40).max(40).optional(),
	skewY: z.number().min(-40).max(40).optional(),
	width: z.number().int().min(1).max(1920),
	height: z.number().int().min(1).max(1080),
	fill: z.string().regex(/^#[0-9a-f]{6}$/i),
	gradient: shapeGradient.optional(),
	stroke: z.string().regex(/^#[0-9a-f]{6}$/i),
	strokeWidth: z.number().int().min(0).max(64),
	radius: z.number().int().min(0).max(540),
}).strict();

/** Maximum length of a graphics text template before Liquid rendering. */
export const MAX_GRAPHICS_TEXT_LENGTH = 4096;

/** Ordered, bounded authoring model shared by YAML and visual editing. */
export const graphicsDocumentSchema = z.object({
	version: z.literal(1),
	layers: z.array(z.discriminatedUnion('kind', [
		z.object({ ...common, kind: z.literal('media'), assetId: z.uuid() }).strict(),
		z.object({ ...common, kind: z.literal('shape'), shape }).strict(),
		z.object({
			...common, kind: z.literal('clock'), width: percent.min(4).max(25),
			badge: z.object({
				color: gradientStop.shape.color, background: gradientStop.shape.color, backgroundOpacity: percent,
			}).strict(),
		}).strict(),
		z.object({
			...common, kind: z.literal('text'), text: z.string().max(MAX_GRAPHICS_TEXT_LENGTH),
			style, styles: z.record(z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/), style).optional(),
		}).strict(),
	])).max(MAX_GRAPHICS_LAYERS),
}).strict().superRefine(({ layers }, context) => {
	const ids = new Set<string>();
	const byId = new Map(layers.map(layer => [layer.id, layer]));
	for (const [index, layer] of layers.entries()) {
		if (ids.has(layer.id)) {
			context.addIssue({ code: 'custom', path: ['layers', index, 'id'], message: 'Layer IDs must be unique' });
		}
		ids.add(layer.id);

		const chain = new Set([layer.id]);
		for (let link = layer.attachment; link; link = byId.get(link.layerId)?.attachment) {
			if (chain.has(link.layerId) || !byId.has(link.layerId) || byId.get(link.layerId)?.kind === 'clock') {
				context.addIssue({ code: 'custom', path: ['layers', index, 'attachment', 'layerId'], message: 'Attach to an existing non-clock layer without creating a cycle' });
				break;
			}
			chain.add(link.layerId);
		}

		if (layer.kind === 'clock' && (layer.timing.mode !== 'always' || layer.rotation !== undefined || layer.attachment)) {
			context.addIssue({ code: 'custom', path: ['layers', index], message: 'Clock layers are always on and use frame or source placement without rotation' });
		}

		const timing = layer.timing;
		if (timing.mode !== 'always' && (timing.fade > timing.hold || timing.hold + 2 * timing.fade === 0
			|| (timing.mode === 'periodic' && (timing.hold + 2 * timing.fade > timing.frequency || timing.phase >= timing.frequency)))) {
			context.addIssue({ code: 'custom', path: ['layers', index, 'timing'], message: 'Require a nonempty appearance, fade ≤ hold, and periodic phase and appearance within the cycle' });
		}
		if (layer.kind === 'text' && Object.keys(layer.styles ?? {}).length > 12) {
			context.addIssue({ code: 'custom', path: ['layers', index, 'styles'], message: 'Use at most 12 named styles' });
		}
	}
});

/** Validated graphics preset content. */
export type GraphicsDocument = z.infer<typeof graphicsDocumentSchema>;
/** One authorable graphics layer. */
export type GraphicsLayer = GraphicsDocument['layers'][number];
/** Aspect ratio of the clock badge in the preview and playback. */
export const graphicsClockSize = { width: 384, height: 108 } as const;

/** A deterministic UTC timeline used in the sample gallery. */
export const graphicsSampleStart = Date.parse('2026-01-01T14:27:36Z');

/** Format a programme or clock instant using an explicit broadcast time zone. */
export function graphicsTimeFormatter(timeZone: string, seconds = false): Intl.DateTimeFormat {
	return new Intl.DateTimeFormat('en-GB', {
		timeZone, hour: '2-digit', minute: '2-digit', ...(seconds ? { second: '2-digit' } : {}), hourCycle: 'h23',
	});
}

/** Shared sample schedule for the browser layout and rendered previews. */
export const graphicsSampleSchedule = [
	{ title: 'The Alpine Expedition', subtitle: 'A journey through the high Alps', start: '2026-01-01T14:00:00Z', finish: '2026-01-01T14:30:00Z', startTime: '14:00' },
	{ title: 'Mountain Rescue', subtitle: null, start: '2026-01-01T14:30:00Z', finish: '2026-01-01T15:30:00Z', startTime: '14:30' },
	{ title: 'Alpine Wildlife', subtitle: null, start: '2026-01-01T15:30:00Z', finish: '2026-01-01T16:30:00Z', startTime: '15:30' },
] as const;

/** Raw catalog fields exposed to Liquid for a playing clip or scheduled airing. */
export const graphicsMediaSchema = z.object({
	title: z.string().nullable(), subtitle: z.string().nullable(), kind: z.string().nullable(),
	seriesTitle: z.string().nullable(), seasonNumber: z.number().nullable(), episodeNumber: z.number().nullable(),
	episodeEndNumber: z.number().nullable(), year: z.number().nullable(), releaseDate: z.string().nullable(),
	description: z.string().nullable(), durationSeconds: z.number().nullable(),
	originalTitle: z.string().nullable(), edition: z.string().nullable(), certification: z.string().nullable(),
	rating: z.number().nullable(), userRating: z.number().nullable(), primaryGenre: z.string().nullable(),
	genres: z.array(z.string()), tags: z.array(z.string()),
	cast: z.array(z.object({ name: z.string(), role: z.string().nullable() })), directors: z.array(z.string()),
	writers: z.array(z.string()), studios: z.array(z.string()), countries: z.array(z.string()),
	artist: z.string().nullable(), artists: z.array(z.string()), album: z.string().nullable(),
	trackNumber: z.number().nullable(), discNumber: z.number().nullable(),
});

/** Raw graphics metadata with null scalars and empty lists for unavailable fields. */
export type GraphicsMedia = z.infer<typeof graphicsMediaSchema>;

/** Committed airing times and guide labels with separate raw catalog metadata. */
export const graphicsAiringSchema = z.object({
	title: z.string(), subtitle: z.string().nullable(), start: z.iso.datetime({ offset: true }),
	finish: z.iso.datetime({ offset: true }), startTime: z.string(), media: graphicsMediaSchema,
	program: programTemplateContextSchema.optional(),
});

/** One complete primary airing exposed to Liquid. */
export type GraphicsAiring = z.infer<typeof graphicsAiringSchema>;

/** Maximum number of distinct upcoming primary airings available to a graphics template. */
export const MAX_GRAPHICS_UPCOMING = 8;

/** Path-free Liquid context shared by both previews and playback. */
export const graphicsContextSchema = z.object({
	channel: z.object({ name: z.string(), number: z.string() }), media: graphicsMediaSchema.nullable(),
	program: programTemplateContextSchema.optional(),
	now: graphicsAiringSchema.nullable(), next: graphicsAiringSchema.nullable(),
	upcoming: z.array(graphicsAiringSchema).max(MAX_GRAPHICS_UPCOMING),
});

/** Complete graphics Liquid values at one point in the broadcast. */
export type GraphicsContext = z.infer<typeof graphicsContextSchema>;

/** Defaults keep the raw media shape stable when catalog metadata is absent. */
export const emptyGraphicsMedia: GraphicsMedia = {
	title: null, subtitle: null, kind: null, seriesTitle: null, seasonNumber: null, episodeNumber: null,
	episodeEndNumber: null, year: null, releaseDate: null, description: null, durationSeconds: null,
	originalTitle: null, edition: null, certification: null, rating: null, userRating: null, primaryGenre: null,
	genres: [], tags: [], cast: [], directors: [], writers: [], studios: [], countries: [],
	artist: null, artists: [], album: null, trackNumber: null, discNumber: null,
};

/** Keep channel identity available while no item can be resolved. */
export function emptyGraphicsContext(channel: GraphicsContext['channel']): GraphicsContext {
	return { channel: { name: channel.name, number: channel.number }, media: null, now: null, next: null, upcoming: [] };
}

/** Use the same representative guide and catalog values in every sample preview. */
const sampleAirings = graphicsSampleSchedule.map((airing, index): GraphicsAiring => ({
	...airing,
	program: { metadata: { showcase_actor: ['Sigourney Weaver', 'Michelle Yeoh', 'Tony Leung'][index]! } },
	media: { ...emptyGraphicsMedia, title: airing.title, kind: 'episode', seriesTitle: 'The Alpine Expedition',
		seasonNumber: 1, episodeNumber: index + 1, year: 2026, durationSeconds: index === 0 ? 1800 : 3600 },
}));

/** Shared deterministic sample Liquid values. */
export const sampleGraphicsContext: GraphicsContext = {
	channel: { name: 'Moirai TV', number: '12' }, media: sampleAirings[0]!.media,
	program: { metadata: { showcase_actor: 'Sigourney Weaver' } },
	now: sampleAirings[0]!, next: sampleAirings[1]!, upcoming: sampleAirings.slice(1),
};

/** Draw a validated clock badge at a fixed aspect ratio for compositing. */
export function graphicsClockSvg(badge: Extract<GraphicsLayer, { kind: 'clock' }>['badge'], time: string, width = 384, height = 108, opacity = 100): string {
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 384 108"><g opacity="${opacity / 100}"><rect width="384" height="108" rx="22" fill="${badge.background}" fill-opacity="${badge.backgroundOpacity / 100}"/><text x="192" y="75" text-anchor="middle" font-family="sans-serif" font-weight="bold" font-size="74" fill="${badge.color}">${time}</text></g></svg>`;
}

/** Build SVG stops along the same direction and span as a CSS linear gradient. */
function graphicsGradientSvg(gradient: z.infer<typeof shapeGradient>, width: number, height: number): string {
	const radians = gradient.angle * Math.PI / 180;
	const x = Math.sin(radians);
	const y = -Math.cos(radians);
	const halfSpan = (Math.abs(x) * width + Math.abs(y) * height) / 2;
	return `<defs><linearGradient id="fill-gradient" gradientUnits="userSpaceOnUse" x1="${width / 2 - x * halfSpan}" y1="${height / 2 - y * halfSpan}" x2="${width / 2 + x * halfSpan}" y2="${height / 2 + y * halfSpan}"><stop offset="0" stop-color="${gradient.start.color}" stop-opacity="${gradient.start.opacity / 100}"/><stop offset="1" stop-color="${gradient.end.color}" stop-opacity="${gradient.end.opacity / 100}"/></linearGradient></defs>`;
}

/** Convert validated geometry into an SVG primitive shared by preview and rasterization. */
export function graphicsShapeSvg(geometry: z.infer<typeof shape>): string {
	const { width, height, fill, gradient, stroke, strokeWidth, radius, primitive } = geometry;
	const inset = Math.min(primitive === 'line' ? Math.max(1, strokeWidth) : strokeWidth, width, height) / 2;
	const definition = gradient && primitive !== 'line' ? graphicsGradientSvg(gradient, width, height) : '';
	const paint = `fill="${definition ? 'url(#fill-gradient)' : fill}" stroke="${stroke}" stroke-width="${inset * 2}"`;
	let element: string;
	if (primitive === 'ellipse') {
		element = `<ellipse cx="${width / 2}" cy="${height / 2}" rx="${width / 2 - inset}" ry="${height / 2 - inset}" ${paint}/>`;
	}
	else if (primitive === 'line') {
		element = `<line x1="${inset}" y1="${height - inset}" x2="${width - inset}" y2="${inset}" ${paint}/>`;
	}
	else {
		const rounding = primitive === 'roundedRectangle' ? radius : 0;
		element = `<rect x="${inset}" y="${inset}" width="${width - 2 * inset}" height="${height - 2 * inset}" rx="${rounding}" ${paint}/>`;
	}
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${definition}${element}</svg>`;
}

/** Preset draft accepted by create and update operations. */
export const graphicsDraftSchema = z.object({
	name: z.string().trim().min(1).max(120),
	yaml: z.string().min(1).max(32_768),
}).strict();
/** Stored preset including its protection status. */
export const graphicsPresetSchema = graphicsDraftSchema.extend({ id: z.uuid(), protected: z.boolean() });
/** Stored graphics preset. */
export type GraphicsPreset = z.infer<typeof graphicsPresetSchema>;
/** Managed asset metadata available to the editor. */
export const graphicsAssetSchema = z.object({
	id: z.uuid(),
	name: z.string(),
	kind: z.enum(['image', 'video', 'font']),
	format: z.enum(['png', 'apng', 'jpeg', 'gif', 'webp', 'webm', 'mp4', 'ttf', 'otf']),
	protected: z.boolean(),
});
/** Managed asset metadata. */
export type GraphicsAsset = z.infer<typeof graphicsAssetSchema>;
/** Render a preset draft against sample data or a committed channel airing. */
export const graphicsPreviewSchema = z.object({
	yaml: graphicsDraftSchema.shape.yaml,
	channelId: z.uuid().optional(),
	elapsedMs: milliseconds,
	showWallClockLayers: z.boolean().optional(),
}).strict();

/** Select a point in a committed channel timeline relative to the preview reference. */
export const graphicsPreviewContextQuerySchema = z.object({
	channelId: z.uuid(), elapsedMs: z.coerce.number().pipe(milliseconds),
}).strict();

/** Tell the editor whether item fields are available for the selected position. */
export const graphicsPreviewContextSchema = z.object({
	availability: z.enum(['available', 'gap', 'unavailable']), context: graphicsContextSchema,
});

/** Public response for the editable graphics preview. */
export type GraphicsPreviewContext = z.infer<typeof graphicsPreviewContextSchema>;

/** A complete text style used by a base layer or one named run. */
export type GraphicsTextStyle = z.infer<typeof style>;

/** Protect interpolated metadata from being interpreted as authored style tags. */
export function escapeGraphicsTextValue(value: unknown): string {
	return String(value ?? '').replaceAll('&', '&amp;').replaceAll('[', '&#91;').replaceAll(']', '&#93;');
}

/** Decode only the escapes used to protect interpolated graphics values. */
export function unescapeGraphicsTextValue(text: string): string {
	return text.replace(/&amp;|&#91;|&#93;/g, entity => ({ '&amp;': '&', '&#91;': '[', '&#93;': ']' })[entity]!);
}

/** Split authored text into styled runs, preserving unknown or mismatched tags literally. */
export function graphicsTextRuns(text: string, base: GraphicsTextStyle, styles: Record<string, GraphicsTextStyle> = {}): Array<{ text: string; style: GraphicsTextStyle }> {
	const stack: string[] = [];
	const runs: Array<{ text: string; style: GraphicsTextStyle }> = [];
	let cursor = 0;
	for (const match of text.matchAll(/\[(\/?)([a-z][a-z0-9_-]{0,31})\]/g)) {
		const name = match[2]!;
		const current = stack.at(-1);
		if (!Object.hasOwn(styles, name) || (match[1] && current !== name)) {
			continue;
		}
		if (match.index! > cursor) {
			runs.push({ text: text.slice(cursor, match.index), style: (current ? styles[current] : undefined) ?? base });
		}
		if (match[1]) {
			stack.pop();
		}
		else {
			stack.push(name);
		}
		cursor = match.index! + match[0].length;
	}
	const final = stack.at(-1);
	if (cursor < text.length) {
		runs.push({ text: text.slice(cursor), style: (final ? styles[final] : undefined) ?? base });
	}
	return runs;
}
