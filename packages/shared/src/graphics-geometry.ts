import type { GraphicsLayer } from './graphics.js';

/** Measurable layer or output dimensions in one coordinate system. */
export interface GraphicsSize {
	width: number;
	height: number;
}

/** Axis-aligned bounds in output coordinates. */
export interface GraphicsRect extends GraphicsSize {
	x: number;
	y: number;
}

/** Untransformed size, final bounds and centered affine matrix for a layer. */
export interface GraphicsGeometry {
	size: GraphicsSize;
	bounds: GraphicsRect;
	matrix: [number, number, number, number];
}

/** Whether the layer requires Moirai to resolve its placement before playout. */
export function hasGraphicsTransform(layer: GraphicsLayer): boolean {
	return Boolean(layer.attachment || layer.rotation || (layer.kind === 'shape' && (layer.shape.skewX || layer.shape.skewY)));
}

/** Locate one of the nine anchor points on a box. */
function anchorPoint(anchor: GraphicsLayer['anchor'], size: GraphicsSize): [number, number] {
	return [
		anchor.endsWith('left') ? 0 : anchor.endsWith('right') ? size.width : size.width / 2,
		anchor.startsWith('top') ? 0 : anchor.startsWith('bottom') ? size.height : size.height / 2,
	];
}

/** Resolve attachment chains without changing layer order or using opacity as geometry. */
export function resolveGraphicsGeometry(layers: readonly GraphicsLayer[], sizes: ReadonlyMap<string, GraphicsSize>, frame: GraphicsSize, content: GraphicsRect = { ...frame, x: 0, y: 0 }): Map<string, GraphicsGeometry> {
	const result = new Map<string, GraphicsGeometry>();
	const byId = new Map(layers.map(layer => [layer.id, layer]));
	const visited = new Set<string>();

	/** Compute a target first, even when it is above the attached layer. */
	function resolve(layer: GraphicsLayer): GraphicsGeometry | undefined {
		if (visited.has(layer.id)) {
			return result.get(layer.id);
		}
		visited.add(layer.id);
		const source = sizes.get(layer.id);
		if (!source?.width || !source.height) {
			return undefined;
		}

		const width = layer.width === undefined ? source.width : Math.round(Math.fround(Math.fround(Math.fround(layer.width) / 100) * Math.fround(frame.width)));
		const height = layer.width === undefined ? source.height : Math.round(Math.fround(width * Math.fround(source.height / source.width)));
		if (width < 1 || height < 1) {
			return undefined;
		}
		const size = layer.width === undefined ? { width, height } : { width: width + width % 2, height: height + height % 2 };
		const angle = (layer.rotation ?? 0) * Math.PI / 180;
		const skewX = Math.tan((layer.kind === 'shape' ? layer.shape.skewX ?? 0 : 0) * Math.PI / 180);
		const skewY = Math.tan((layer.kind === 'shape' ? layer.shape.skewY ?? 0 : 0) * Math.PI / 180);
		const cos = Math.cos(angle);
		const sin = Math.sin(angle);
		const matrix: GraphicsGeometry['matrix'] = [cos - sin * skewY, sin + cos * skewY, cos * skewX - sin, sin * skewX + cos];
		const [a, b, c, d] = matrix;
		const bounds = { width: Math.abs(a) * size.width + Math.abs(c) * size.height,
			height: Math.abs(b) * size.width + Math.abs(d) * size.height, x: 0, y: 0 };
		// Place the skewed box before rotation so changing the angle leaves its center fixed.
		const placementSize = {
			width: size.width + Math.abs(skewX) * size.height,
			height: size.height + Math.abs(skewY) * size.width,
		};
		const [ownX, ownY] = anchorPoint(layer.anchor, placementSize);
		if (layer.attachment) {
			const target = byId.get(layer.attachment.layerId);
			const reference = target && resolve(target)?.bounds;
			if (!reference) {
				return undefined;
			}
			const [x, y] = anchorPoint(layer.attachment.anchor, reference);
			bounds.x = reference.x + x + reference.width * layer.attachment.offsetX / 100 - ownX;
			bounds.y = reference.y + y + reference.height * layer.attachment.offsetY / 100 - ownY;
		}
		else {
			const reference = layer.withinSource ? content : { ...frame, x: 0, y: 0 };
			const x = reference.width * layer.horizontalMargin / 100;
			const y = reference.height * layer.verticalMargin / 100;
			const minimum = skewX || skewY ? -Infinity : 0;
			bounds.x = layer.anchor.endsWith('left') ? reference.x + x : layer.anchor.endsWith('right')
				? Math.max(minimum, reference.x + reference.width - placementSize.width - x) : Math.max(minimum, (frame.width - placementSize.width) / 2) + x;
			bounds.y = layer.anchor.startsWith('top') ? reference.y + y : layer.anchor.startsWith('bottom')
				? Math.max(minimum, reference.y + reference.height - placementSize.height - y) : Math.max(minimum, (frame.height - placementSize.height) / 2) + y;
		}
		bounds.x += (placementSize.width - bounds.width) / 2;
		bounds.y += (placementSize.height - bounds.height) / 2;
		const geometry = { size, bounds, matrix };
		result.set(layer.id, geometry);
		return geometry;
	}

	for (const layer of layers) {
		resolve(layer);
	}
	return result;
}
