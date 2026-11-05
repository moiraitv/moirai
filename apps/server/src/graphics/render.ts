import { assertGraphicsScale, validateGraphicsScale } from './dimensions.js';
import { graphicsFontAlias, renderWithGraphicsFonts } from './fonts.js';
import { createHash } from 'node:crypto';
import { createBoundedLiquid } from '../liquid-template.js';
import sharp from 'sharp';
import { escapeGraphicsTextValue, unescapeGraphicsTextValue, graphicsShapeSvg, graphicsTextRuns, type Channel, type GraphicsAsset, type GraphicsLayer, type GraphicsContext, type GraphicsTextStyle } from '@moirai/shared';
import type { EtvMediaGraphicsLayer } from '@moirai/ersatztv-contract';
import type { GraphicsSnapshots } from './snapshots.js';
import { graphicsAssetPath, publishGraphicsFile } from './assets.js';

/** Safe Liquid engine shared by preview and playout. */
const liquid = createBoundedLiquid({
	parseLimit: 4096, renderLimit: 100, memoryLimit: 64 * 1024, outputEscape: escapeGraphicsTextValue,
});

/** Validate Liquid syntax at the preset boundary before an assignment can reach playback. */
export function validateGraphicsTemplate(source: string): void {
	liquid.parse(source);
}

export type { GraphicsContext } from '@moirai/shared';
export { sampleGraphicsContext } from '@moirai/shared';
export { graphicsContexts } from './context.js';

/** Maximum periodic appearances admitted for one playout item. */
export const MAX_GRAPHICS_APPEARANCES = 512;

/** Convert author timing to the pinned engine's native periodic clock. */
export function graphicsTiming(timing: GraphicsLayer['timing'], durationMs: number): EtvMediaGraphicsLayer['timing'] {
	if (timing.mode === 'always') {
		return undefined;
	}
	if (timing.mode === 'once') {
		return {
			timing_type: 'periodic', clock: 'content', phase_offset_ms: timing.phase,
			frequency_ms: timing.phase + timing.hold + 2 * timing.fade + 1,
			disable_after_ms: timing.phase + 1, fade_ms: timing.fade, hold_ms: timing.hold,
		};
	}
	if (Math.ceil(Math.min(durationMs, timing.cutoff ?? Infinity) / timing.frequency) > MAX_GRAPHICS_APPEARANCES) {
		throw new Error('Graphics timing exceeds 512 appearances per playout item');
	}
	return {
		timing_type: 'periodic', clock: timing.clock, frequency_ms: timing.frequency, phase_offset_ms: timing.phase,
		...(timing.cutoff === undefined ? {} : { disable_after_ms: timing.cutoff }), fade_ms: timing.fade, hold_ms: timing.hold,
	};
}

/** Convert protected Liquid text and style runs to safe Pango markup. */
function markup(runs: ReturnType<typeof graphicsTextRuns>): string {
	return runs.map(run => {
		const family = run.style.fontId ? graphicsFontAlias(run.style.fontId) : undefined;
		return styleTag(run.style, family) + pangoText(run.text) + '</span>';
	}).join('');
}

/** Escape Pango text while decoding only the controlled Liquid escape sequences. */
function pangoText(text: string): string {
	return unescapeGraphicsTextValue(text)
		.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/** Emit only validated style properties into Pango markup. */
function styleTag(style: GraphicsTextStyle, family = 'Sans'): string {
	return `<span foreground="${style.color}" size="${style.size * 1024}" weight="${style.bold ? 'bold' : 'normal'}" style="${style.italic ? 'italic' : 'normal'}" font_family="${pangoText(family).replaceAll('"', '&quot;')}">`;
}

/** Prepare one native media layer using the same contract for preview and playout. */
export async function prepareGraphicsLayer(root: string, layer: GraphicsLayer, assets: Map<string, GraphicsAsset>, context: GraphicsContext, durationMs: number, snapshots: GraphicsSnapshots, output: Pick<Channel['video'], 'width' | 'height'>, ffprobe = 'ffprobe'): Promise<EtvMediaGraphicsLayer | null> {
	if (layer.kind === 'clock') {
		throw new Error('Live clock layers require a canvas source');
	}
	const timing = graphicsTiming(layer.timing, durationMs);
	let source: string;
	if (layer.kind === 'media') {
		const asset = assets.get(layer.assetId)!;
		source = await graphicsAssetPath(root, asset);
		await validateGraphicsScale(source, asset.kind === 'video', ffprobe, layer.width, output);
		if (!asset.protected) {
			source = await snapshots.media(source);
		}
	}
	else if (layer.kind === 'shape') {
		assertGraphicsScale(layer.shape, layer.width, output);
		const svg = graphicsShapeSvg(layer.shape);
		const key = createHash('sha256').update(svg).digest('hex');
		source = await snapshots.use(`${key}.png`, async destination => {
			const data = await sharp(Buffer.from(svg)).timeout({ seconds: 1 }).png().toBuffer();
			await publishGraphicsFile(destination, data);
		});
	}
	else {
		const text = String(await liquid.parseAndRender(layer.text, context));
		if (!text.trim()) {
			return null;
		}
		if (text.length > 1024 || text.split('\n').length > 12) {
			throw new Error('Rendered graphics text exceeds its size limit');
		}

		const key = createHash('sha256').update(JSON.stringify([4, text, layer.style, layer.styles])).digest('hex');
		const content = graphicsTextRuns(text, layer.style, layer.styles);
		if (!content.length) {
			return null;
		}
		source = await snapshots.use(`${key}.png`, async destination => {
			const fontIds = new Set(content.flatMap(run => run.style.fontId ? [run.style.fontId] : []));
			const markedUp = markup(content);
			const data = fontIds.size
				? await renderWithGraphicsFonts(root, markedUp, [...fontIds].map(id => assets.get(id)!))
				: await sharp({ text: { text: markedUp, font: 'Sans', width: 1920, rgba: true } })
					.timeout({ seconds: 1 }).png().toBuffer();
			const { width, height } = await sharp(data).metadata();
			if (height > 1080) {
				throw new Error('Rendered graphics text exceeds 1080 pixels in height');
			}
			assertGraphicsScale({ width, height }, layer.width, output);
			await publishGraphicsFile(destination, data);
		});
		await validateGraphicsScale(source, false, ffprobe, layer.width, output);
	}

	return {
		kind: 'media', source: { source_type: 'local', path: source }, location: layer.anchor,
		...(layer.width === undefined ? {} : { width_percent: layer.width }), horizontal_margin_percent: layer.horizontalMargin, vertical_margin_percent: layer.verticalMargin,
		opacity_percent: layer.opacity, within_source_content: layer.withinSource, ...(timing ? { timing } : {}),
	};
}
