import { graphicsExampleIds, type GraphicsAsset, type GraphicsLayer, type GraphicsPreset } from '@moirai/shared';
import { stringify } from 'yaml';

/** Packaged media available independently of managed uploads. */
export const exampleGraphicsAssets: GraphicsAsset[] = [
	{ id: '2cd52ff4-16dc-4349-9000-166b643d1011', name: 'Moirai sample logo', kind: 'image', format: 'png', protected: true },
	{ id: '2cd52ff4-16dc-4349-9000-166b643d1012', name: 'Animated sample logo', kind: 'image', format: 'gif', protected: true },
];

/** Construct an immutable example with a stable layer identity. */
function example(index: number, name: string, ...layers: GraphicsLayer[]): GraphicsPreset {
	return { id: graphicsExampleIds[index]!, name, protected: true, yaml: stringify({ version: 1, layers }, { aliasDuplicateObjects: false }) };
}

/** A starting placement shared by the bundled examples. */
const corner = {
	id: '2cd52ff4-16dc-4349-9000-166b643d1021',
	anchor: 'bottom_right', horizontalMargin: 4, verticalMargin: 5, opacity: 70, withinSource: true,
	timing: { mode: 'always' },
} as const;

/** Shared timed appearance for the two programme cards. */
const programmeTiming = { mode: 'once', phase: 3000, fade: 1500, hold: 8500 } as const;

/** Create a broadcast panel with stable layer identity and editable paint. */
function panel(id: string, width: number, height: number, fill: string, placement: Partial<Extract<GraphicsLayer, { kind: 'shape' }>> = {}): Extract<GraphicsLayer, { kind: 'shape' }> {
	return {
		...corner, id: `2cd52ff4-16dc-4349-9000-166b643d${id}`, kind: 'shape', opacity: 100,
		...placement,
		shape: { primitive: 'rectangle', width, height, fill, stroke: fill, strokeWidth: 0, radius: 0, ...placement.shape },
	};
}

/** Position text or a tab relative to its panel so it stays aligned when moved. */
function attached(layer: GraphicsLayer, anchor: GraphicsLayer['anchor'], offsetX: number, offsetY: number): NonNullable<GraphicsLayer['attachment']> {
	return { layerId: layer.id, anchor, offsetX, offsetY };
}

/** Styled text anchored to an editable background panel. */
function caption(id: string, text: string, size: number, placement: Partial<Extract<GraphicsLayer, { kind: 'text' }>>): Extract<GraphicsLayer, { kind: 'text' }> {
	return {
		...corner, id: `2cd52ff4-16dc-4349-9000-166b643d${id}`, kind: 'text',
		anchor: 'top_left', opacity: 100, text, style: { size, color: '#FFFFFF', bold: true }, ...placement,
	};
}

/** Shared navy and mint palette for the programme examples. */
const navy = '#0B1F35';
/** Accent used for labels and dividers. */
const mint = '#13E8CB';
/** Navy paint fading to transparent across the width of the card. */
const fade = { angle: 90, start: { color: navy, opacity: 96 }, end: { color: navy, opacity: 0 } };

/** Main programme banner and its mint accents. */
const lower = panel('1031', 1710, 180, navy, { name: 'Now Playing Background', anchor: 'bottom_left', horizontalMargin: 3, verticalMargin: 6, width: 89, timing: programmeTiming });
lower.shape.gradient = fade;
lower.shape.skewX = -16;
const accent = panel('1032', 26, 180, mint, { name: 'Mint Accent', anchor: 'center_left', width: 26 / 1920 * 100, attachment: attached(lower, 'center_left', 0, 0), timing: programmeTiming });
accent.shape.skewX = -16;
/** Join the tab to the accent’s upper-right corner through their matching corners. */
const nowTab = panel('1033', 440, 64, mint, { name: 'Now Playing Tab', anchor: 'bottom_left', width: 23, attachment: attached(accent, 'top_right', 0, 0), timing: programmeTiming });
nowTab.shape.skewX = -16;

/** Compact next-programme card. */
const nextCard = panel('1036', 480, 110, navy, { name: 'Up Next Background', anchor: 'top_right', horizontalMargin: 3, verticalMargin: 9, width: 25, timing: programmeTiming });
nextCard.shape.gradient = fade;
nextCard.shape.skewX = -16;

/** Stationary two-programme schedule strip. */
const strip = panel('1041', 1770, 112, navy, { name: 'Ticker Background', anchor: 'bottom_left', horizontalMargin: 4, verticalMargin: 5, width: 92, opacity: 92 });
strip.shape.primitive = 'roundedRectangle';
strip.shape.radius = 22;
strip.shape.skewX = -14;
strip.shape.gradient = { angle: 90, start: { color: navy, opacity: 100 }, end: { color: navy, opacity: 88 } };
const stripTab = panel('1042', 280, 112, mint, { name: 'Up Next Tab', anchor: 'center_left', width: 14.6, attachment: attached(strip, 'center_left', 0, 0) });
stripTab.shape.skewX = -14;

/** Protected presets available on every installation. */
export const graphicsExamples = [
	example(0, 'Corner Watermark', { ...corner, kind: 'media', name: 'Watermark', width: 12, assetId: exampleGraphicsAssets[0]!.id }),
	example(
		1,
		'Now Playing & Up Next',
		lower,
		accent,
		nowTab,
		caption('1034', 'NOW PLAYING', 38, { name: 'Now Playing Label', anchor: 'center', attachment: attached(nowTab, 'center', 0, 0), style: { size: 38, color: navy, bold: true }, timing: programmeTiming }),
		caption('1035', '{{ now.title | default: "Now playing" | truncate: 38 }}', 64, {
			name: 'Programme Title', anchor: 'center_left', attachment: attached(lower, 'center_left', 5.8, -17), timing: programmeTiming,
		}),
		caption('1039', '{{ now.subtitle | upcase | truncate: 60 }}', 36, {
			name: 'Programme Subtitle', anchor: 'center_left', attachment: attached(lower, 'center_left', 5.8, 22),
			style: { size: 36, color: '#FFFFFF' }, timing: programmeTiming,
		}),
		nextCard,
		caption('1038', '[label]UP NEXT[/label]\n{{ next.title | default: "To be announced" | truncate: 22 }}', 34, {
			name: 'Up Next Text', anchor: 'center_left', attachment: attached(nextCard, 'center_left', 9, 0),
			styles: { label: { size: 26, color: mint, bold: true } }, timing: programmeTiming,
		}),
	),
	example(2, 'Channel ID', {
		...corner, anchor: 'top_right', kind: 'text', name: 'Channel Name', text: '{{ channel.name }}',
		style: { size: 48, color: '#FFFFFF', bold: true },
		timing: { mode: 'periodic', clock: 'wall', frequency: 60_000, phase: 0, fade: 1000, hold: 6000 },
	}),
	example(3, 'Animated Corner Bug', { ...corner, kind: 'media', name: 'Animated Logo', width: 12, assetId: exampleGraphicsAssets[1]!.id }),
	example(4, 'Live Clock', {
		...corner, id: '2cd52ff4-16dc-4349-9000-166b643d1051', anchor: 'top_right', kind: 'clock', name: 'Clock', width: 20, horizontalMargin: 3, verticalMargin: 4, opacity: 100, withinSource: false,
		badge: { color: '#FFFFFF', background: navy, backgroundOpacity: 90 },
	}),
	example(
		5,
		'Upcoming Ticker',
		strip,
		stripTab,
		caption('1043', 'UP NEXT', 39, { name: 'Up Next Label', anchor: 'center', attachment: attached(stripTab, 'center', 0, 0), style: { size: 39, color: navy, bold: true } }),
		caption('1044', '{% if upcoming[0] %}{{ upcoming[0].startTime }}   {{ upcoming[0].title | truncate: 20 }}{% if upcoming[1] %}   [divider]│[/divider]   {{ upcoming[1].startTime }}   {{ upcoming[1].title | truncate: 20 }}{% endif %}{% else %}Schedule to be announced{% endif %}', 36, {
			name: 'Programme Times and Titles', anchor: 'center_left', attachment: attached(stripTab, 'center_right', 13, 0), styles: { divider: { size: 36, color: mint } },
		}),
	),
];
