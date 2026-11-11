<script setup lang="ts">
import { Context, Liquid } from 'liquidjs';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import sampleStill from '../../../../server/assets/graphics-preview.jpg';
import { useProgramMetadataLookup, escapeGraphicsTextValue, unescapeGraphicsTextValue, graphicsClockSize, graphicsClockSvg, sampleGraphicsContext, graphicsSampleStart, graphicsTimeFormatter, graphicsShapeSvg, graphicsTextRuns, resolveGraphicsGeometry, type GraphicsContext, type GraphicsGeometry, type GraphicsSize, type GraphicsAsset, type GraphicsLayer, type GraphicsTextStyle } from '@moirai/shared';

const props = defineProps<{ layers: GraphicsLayer[]; assets: GraphicsAsset[]; selected?: string; disabled?: boolean; elapsedMs: number; frame?: string; context?: GraphicsContext | undefined; thumbnail?: boolean }>();
const emit = defineEmits<{ select: [id: string]; patch: [id: string, changes: Record<string, unknown>] }>();
const stage = ref<HTMLElement>();
const sampleClock = computed(() => clockFormatter.format(graphicsSampleStart + props.elapsedMs));
const sizes = ref(new Map<string, GraphicsSize>());
const gesture = ref<{ layer: GraphicsLayer; geometry: GraphicsGeometry; x: number; y: number; handle: string; changes: Record<string, unknown> }>();
/** Render bounded templates against representative data without loading external files. */
const sampleLiquid = new Liquid({
	strictFilters: true, lenientIf: true, ownPropertyOnly: true, parseLimit: 4096, renderLimit: 100, memoryLimit: 64 * 1024, outputEscape: escapeGraphicsTextValue,
});
for (const tag of ['include', 'render', 'layout']) {
	sampleLiquid.registerTag(tag, {
		parse() {
			throw new Error('File-loading tags are disabled');
		},
		render() {
			return '';
		},
	});
}
/** Use the same deterministic zone as the sample video renderer. */
const clockFormatter = graphicsTimeFormatter('UTC', true);
/** A common editing coordinate system for the sample frame. */
const frameSize = { width: 1920, height: 1080 };
/** Handles are positioned on the untransformed layer and projected through its matrix. */
const handles = [
	{ id: 'nw', x: -1, y: -1 }, { id: 'n', x: 0, y: -1 }, { id: 'ne', x: 1, y: -1 },
	{ id: 'e', x: 1, y: 0 }, { id: 'se', x: 1, y: 1 }, { id: 's', x: 0, y: 1 },
	{ id: 'sw', x: -1, y: 1 }, { id: 'w', x: -1, y: 0 }, { id: 'rotate', x: 0, y: -1 },
];
const displayed = computed(() => props.layers.map(layer => gesture.value?.layer.id === layer.id ? { ...layer, ...gesture.value.changes } as GraphicsLayer : layer));
const geometry = computed(() => resolveGraphicsGeometry(
	displayed.value,
	new Map(displayed.value.flatMap(layer => {
		const size = layer.kind === 'shape' ? layer.shape : layer.kind === 'clock' ? graphicsClockSize : sizes.value.get(layer.id);
		return size ? [[layer.id, size] as const] : [];
	})),
	frameSize,
));
const selectedLayer = computed(() => displayed.value.find(layer => layer.id === props.selected));
const selectedGeometry = computed(() => props.selected ? geometry.value.get(props.selected) : undefined);
const visibleHandles = computed(() => {
	const value = selectedGeometry.value;
	if (!value) {
		return [];
	}
	return handles.filter(handle => selectedLayer.value?.kind === 'shape' || (handle.id.length !== 1 && (selectedLayer.value?.kind !== 'clock' || handle.id !== 'rotate'))).flatMap(handle => {
		const { left, top } = handlePosition(handle, value);
		const outside = handle.id !== 'rotate' && (left < 0 || top < 0 || left > frameSize.width || top > frameSize.height);
		// Keep an active handle mounted so it retains pointer capture during the drag.
		if (outside && gesture.value?.handle !== handle.id) {
			return [];
		}
		return [{ id: handle.id, style: {
			left: `clamp(8px, ${unit(left)}, calc(100% - 8px))`,
			top: `clamp(8px, ${unit(top)}, calc(100% - 8px))`,
			visibility: outside ? 'hidden' as const : undefined,
		} }];
	});
});
let observer: ResizeObserver | undefined;

/** Store intrinsic media or text size without reacting to its own CSS transform. */
function measure(): void {
	const width = stage.value?.clientWidth;
	if (!width) {
		return;
	}
	const measured = new Map<string, GraphicsSize>();
	for (const node of stage.value!.querySelectorAll<HTMLElement>('[data-graphics-source]')) {
		const id = node.dataset.graphicsSource!;
		const size = node instanceof HTMLImageElement ? { width: node.naturalWidth, height: node.naturalHeight }
			: node instanceof HTMLVideoElement ? { width: node.videoWidth, height: node.videoHeight }
				: { width: node.offsetWidth * 1920 / width, height: node.offsetHeight * 1920 / width };
		if (size.width && size.height) {
			measured.set(id, size);
		}
	}
	if (measured.size !== sizes.value.size || [...measured].some(([id, size]) => size.width !== sizes.value.get(id)?.width || size.height !== sizes.value.get(id)?.height)) {
		sizes.value = measured;
	}
}

/** Convert design coordinates to responsive canvas units. */
function unit(value: number): string {
	return `${value / 19.2}cqw`;
}

/** Apply the shared bounds and centered transform while keeping timing independent. */
function layout(layer: GraphicsLayer) {
	const timing = layer.timing;
	let alpha = layer.opacity / 100;
	if (timing.mode === 'once' || (timing.mode === 'periodic' && timing.clock === 'content')) {
		const elapsed = props.elapsedMs - timing.phase;
		const phase = timing.mode === 'periodic' && elapsed >= 0 ? elapsed % timing.frequency : elapsed;
		const cycleStart = props.elapsedMs - phase;
		const cutoff = timing.mode === 'periodic' ? timing.cutoff ?? Infinity : Infinity;
		alpha *= cycleStart >= cutoff || phase < 0 || phase >= timing.hold + 2 * timing.fade ? 0
			: Math.min(1, phase / timing.fade, (timing.hold + 2 * timing.fade - phase) / timing.fade);
	}
	const resolved = geometry.value.get(layer.id);
	if (!resolved) {
		return { opacity: 0, pointerEvents: 'none' } as const;
	}
	const { bounds, size, matrix } = resolved;
	return {
		left: unit(bounds.x + (bounds.width - size.width) / 2),
		top: unit(bounds.y + (bounds.height - size.height) / 2),
		width: unit(size.width),
		height: unit(size.height),
		transform: `matrix(${matrix.join(',')},0,0)`,
		opacity: Math.max(layer.id === props.selected ? 0.25 : 0, alpha),
	};
}

/** Place text at its measured font size before scaling it proportionally. */
function textScale(layer: GraphicsLayer) {
	const width = sizes.value.get(layer.id)?.width;
	const target = geometry.value.get(layer.id)?.size.width;
	return width && target ? { transform: `scale(${target / width})` } : {};
}

/** Project an editing handle through the same affine transform as the layer. */
function handlePosition(handle: typeof handles[number], value: GraphicsGeometry) {
	const { size, bounds, matrix: [a, b, c, d] } = value;
	const x = handle.x * size.width / 2;
	const y = handle.y * size.height / 2 - (handle.id === 'rotate' ? 48 : 0);
	const left = bounds.x + bounds.width / 2 + a * x + c * y;
	const top = bounds.y + bounds.height / 2 + b * x + d * y;
	return { left, top };
}

/** Convert a pointer to the sample frame's coordinate system. */
function point(event: PointerEvent): [number, number] {
	const rect = stage.value!.getBoundingClientRect();
	return [(event.clientX - rect.left) * 1920 / rect.width, (event.clientY - rect.top) * 1080 / rect.height];
}

/** Capture one editing gesture without changing the saved draft. */
function start(event: PointerEvent, layer: GraphicsLayer, handle = 'move'): void {
	if (props.thumbnail) {
		return;
	}
	emit('select', layer.id);
	const resolved = geometry.value.get(layer.id);
	if (props.disabled || event.button !== 0 || !resolved) {
		return;
	}
	(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
	const [x, y] = point(event);
	gesture.value = { layer, geometry: resolved, x, y, handle, changes: {} };
}

/** Keep bounded decimal placement and angle inputs stable across pointer events. */
function limit(value: number, min: number, max: number): number {
	return Math.round(Math.max(min, Math.min(max, value)) * 10) / 10;
}

/** Update only the transient geometry while the pointer moves. */
function updateGesture(x: number, y: number): void {
	const active = gesture.value;
	if (!active) {
		return;
	}
	const { layer, handle, geometry: { size, bounds, matrix: [a, b, c, d] } } = active;
	const dx = x - active.x;
	const dy = y - active.y;
	if (handle === 'move') {
		const target = layer.attachment && geometry.value.get(layer.attachment.layerId)?.bounds;
		active.changes = target && layer.attachment ? { attachment: { ...layer.attachment,
			offsetX: limit(layer.attachment.offsetX + dx * 100 / target.width, -100, 100),
			offsetY: limit(layer.attachment.offsetY + dy * 100 / target.height, -100, 100) } } : {
			horizontalMargin: limit(layer.horizontalMargin + dx * (layer.anchor.endsWith('right') ? -1 : 1) / 19.2, 0, 100),
			verticalMargin: limit(layer.verticalMargin + dy * (layer.anchor.startsWith('bottom') ? -1 : 1) / 10.8, 0, 100),
		};
	}
	else if (handle === 'rotate') {
		const cx = bounds.x + bounds.width / 2;
		const cy = bounds.y + bounds.height / 2;
		const delta = (Math.atan2(y - cy, x - cx) - Math.atan2(active.y - cy, active.x - cx)) * 180 / Math.PI;
		active.changes = { rotation: limit((((layer.rotation ?? 0) + delta + 540) % 360) - 180, -180, 180) };
	}
	else {
		const axis = handles.find(candidate => candidate.id === handle)!;
		const determinant = a * d - b * c;
		const localX = (d * dx - c * dy) / determinant;
		const localY = (a * dy - b * dx) / determinant;
		const horizontal = layer.anchor.endsWith('left') || layer.anchor.endsWith('right') ? 1 : 2;
		const vertical = layer.anchor.startsWith('top') || layer.anchor.startsWith('bottom') ? 1 : 2;
		if (layer.kind === 'shape') {
			const scale = size.width / layer.shape.width;
			const width = Math.round(limit(layer.shape.width + axis.x * localX * horizontal / scale, 1, 1920));
			const height = Math.round(limit(layer.shape.height + axis.y * localY * vertical / scale, 1, 1080));
			active.changes = { shape: { ...layer.shape, width, height }, ...(layer.width === undefined ? {} : { width: limit(width * scale / 19.2, 1, 100) }) };
		}
		else {
			const scale = (axis.x * localX * horizontal * size.width + axis.y * localY * vertical * size.height)
				/ (size.width ** 2 + size.height ** 2);
			active.changes = { width: limit(size.width * (1 + scale) / 19.2, layer.kind === 'clock' ? 4 : 1, layer.kind === 'clock' ? 25 : 100) };
		}
	}
}

/** Move the active handle with a captured pointer. */
function move(event: PointerEvent): void {
	if (gesture.value) {
		updateGesture(...point(event));
	}
}

/** Nudge a resize handle or angle with the arrow keys. */
function nudge(event: KeyboardEvent, layer: GraphicsLayer, handle: string): void {
	const arrows: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
	const direction = arrows[event.key];
	const resolved = geometry.value.get(layer.id);
	if (!direction || !resolved || gesture.value) {
		return;
	}
	event.preventDefault();
	const step = event.shiftKey ? 10 : 1;
	if (handle === 'rotate') {
		emit('patch', layer.id, { rotation: limit((layer.rotation ?? 0) + (direction[0] || -direction[1]) * step, -180, 180) });
		return;
	}
	gesture.value = { layer, geometry: resolved, x: 0, y: 0, handle, changes: {} };
	updateGesture(direction[0] * step * 2, direction[1] * step * 2);
	finish();
}

/** Commit one YAML edit after a completed gesture. */
function finish(): void {
	const active = gesture.value;
	gesture.value = undefined;
	if (active && Object.keys(active.changes).length) {
		emit('patch', active.layer.id, active.changes);
	}
}

/** Cancel the gesture before Escape can close the editor. */
function cancel(event: KeyboardEvent): void {
	if (event.key === 'Escape' && gesture.value) {
		gesture.value = undefined;
		event.preventDefault();
		event.stopImmediatePropagation();
	}
}

onMounted(() => {
	observer = new ResizeObserver(measure);
	if (stage.value) {
		observer.observe(stage.value);
	}
	window.addEventListener('keydown', cancel, true);
});
watch(() => [props.layers, props.context, props.frame], measure, { flush: 'post' });
onBeforeUnmount(() => {
	observer?.disconnect();
	window.removeEventListener('keydown', cancel, true);
});

/** Substitute committed or sample fields and styles in the immediate placement preview. */
function sampleRuns(layer: Extract<GraphicsLayer, { kind: 'text' }>) {
	try {
		const context = props.context ?? sampleGraphicsContext;
		const scope = new Context(context, sampleLiquid.options, {}, { liquid: sampleLiquid });
		useProgramMetadataLookup(scope, context);
		const text = sampleLiquid.renderSync(sampleLiquid.parse(layer.text), scope);
		return graphicsTextRuns(text, layer.style, layer.styles).map(run => ({ ...run, text: unescapeGraphicsTextValue(run.text) }));
	}
	catch {
		return graphicsTextRuns(layer.text, layer.style, layer.styles);
	}
}

/** Show a still image for animated overlays when the canvas is a gallery fallback. */
function mediaImageUrl(assetId: string): string {
	const format = props.assets.find(asset => asset.id === assetId)?.format;
	const poster = props.thumbnail && (format === 'gif' || format === 'apng');
	return `/api/v1/graphics/assets/${assetId}${poster ? '/poster' : ''}`;
}

/** Match the authoring frame scale when showing immediate text edits. */
function textStyle(style: GraphicsTextStyle) {
	return { color: style.color, fontSize: `${style.size / 19.2}cqw`, fontWeight: style.bold ? 700 : 400, fontStyle: style.italic ? 'italic' : 'normal' } as const;
}
</script>

<template>
	<div ref="stage" class="graphics-canvas" :class="{ 'graphics-canvas-thumbnail': thumbnail }" :aria-hidden="thumbnail || undefined" :aria-label="thumbnail ? undefined : 'Graphics preview'" @pointermove="move" @pointerup="finish" @pointercancel="gesture = undefined" @lostpointercapture="gesture = undefined">
		<img v-if="!frame" class="graphics-monitor-still" :src="sampleStill" alt="" draggable="false" :loading="thumbnail ? 'lazy' : undefined" />
		<div v-if="!frame && !thumbnail" class="graphics-safe-area" aria-hidden="true"></div>
		<img v-if="frame" class="graphics-rendered-frame" :src="frame" alt="Frame rendered by Next" />
		<component
			:is="thumbnail ? 'div' : 'button'" v-for="(layer, index) in displayed" v-show="!frame" :key="layer.id" :type="thumbnail ? undefined : 'button'"
			class="graphics-canvas-layer" :class="{ selected: layer.id === selected, 'scaled-media': layer.kind === 'media' }" :style="layout(layer)"
			:aria-label="thumbnail ? undefined : `Select layer ${displayed.length - index}${layer.name ? `: ${layer.name}` : ''}`" @click="!thumbnail && emit('select', layer.id)"
			@pointerdown="start($event, layer)"
		>
			<template v-if="layer.kind === 'media'">
				<video v-if="assets.find(asset => asset.id === layer.assetId)?.kind === 'video'" :data-graphics-source="layer.id" :src="`/api/v1/graphics/assets/${layer.assetId}`" muted :autoplay="!thumbnail" :loop="!thumbnail" :preload="thumbnail ? 'metadata' : undefined" playsinline @loadedmetadata="measure" />
				<img v-else :data-graphics-source="layer.id" :src="mediaImageUrl(layer.assetId)" alt="" draggable="false" :loading="thumbnail ? 'lazy' : undefined" @load="measure" />
			</template>
			<img v-else-if="layer.kind === 'shape'" :src="`data:image/svg+xml,${encodeURIComponent(graphicsShapeSvg(layer.shape))}`" alt="" draggable="false" style="width: 100%" />
			<img v-else-if="layer.kind === 'clock'" :src="`data:image/svg+xml,${encodeURIComponent(graphicsClockSvg(layer.badge, sampleClock))}`" :alt="sampleClock" draggable="false" style="width: 100%" />
			<span v-else :data-graphics-source="layer.id" class="graphics-layer-text" :style="{ ...textScale(layer), fontSize: unit(layer.style.size), lineHeight: 1.15 }"><span v-for="(run, part) in sampleRuns(layer)" :key="part" :style="textStyle(run.style)">{{ run.text }}</span></span>
		</component>
		<template v-if="!frame && !thumbnail && !disabled && selectedLayer && selectedGeometry">
			<button
				v-for="handle in visibleHandles" :key="handle.id" type="button" class="graphics-transform-handle"
				:class="{ rotation: handle.id === 'rotate' }" :style="handle.style"
				:aria-label="handle.id === 'rotate' ? 'Rotate layer' : `Resize layer ${handle.id}`"
				@pointerdown.stop="start($event, selectedLayer, handle.id)" @keydown="nudge($event, selectedLayer, handle.id)" />
			<output v-if="gesture?.handle === 'rotate'" class="graphics-transform-angle">{{ selectedLayer.rotation ?? 0 }}°</output>
		</template>
		<slot />
	</div>
</template>
