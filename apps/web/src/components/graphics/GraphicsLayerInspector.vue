<script setup lang="ts">
import { Upload } from '@lucide/vue';
import { computed, nextTick, ref, useId } from 'vue';
import { graphicsAnchors, graphicsShapes, MAX_GRAPHICS_LAYER_NAME_LENGTH, MAX_GRAPHICS_TEXT_LENGTH, MIN_GRAPHICS_FADE_MS, type GraphicsAsset, type GraphicsLayer } from '@moirai/shared';
import GraphicsPicker from './GraphicsPicker.vue';
import GraphicsMediaThumbnail from './GraphicsMediaThumbnail.vue';
import GuideTemplateValuesPopover from '../GuideTemplateValuesPopover.vue';
import TwoStepActionButton from '../TwoStepActionButton.vue';

const props = defineProps<{ layer: GraphicsLayer; layers: GraphicsLayer[]; assets: GraphicsAsset[]; disabled: boolean }>();
const emit = defineEmits<{ patch: [changes: Record<string, unknown>]; uploadMedia: [event: Event, layerId: string] }>();
const gradientSwatch = computed(() => {
	const gradient = props.layer.kind === 'shape' ? props.layer.shape.gradient : undefined;
	if (!gradient) {
		return undefined;
	}
	const stops = [gradient.start, gradient.end].map(({ color, opacity }) =>
		color + Math.round(opacity * 255 / 100).toString(16).padStart(2, '0'));
	return `linear-gradient(${gradient.angle}deg, ${stops.join(', ')})`;
});
const mediaAssets = computed(() => props.assets.filter(asset => asset.kind !== 'font'));
const styleName = ref('');
const anchorGroup = useId();
const mediaInput = ref<HTMLInputElement>();
const textInput = ref<HTMLTextAreaElement>();
const fieldPicker = ref<InstanceType<typeof GuideTemplateValuesPopover>>();
/** Guide labels and airing times are separate from raw catalog fields. */
const airingFields = {
	title: 'Guide title', subtitle: 'Guide subtitle', start: 'Programme start (ISO)', finish: 'Programme finish (ISO)',
	startTime: '14:30 (broadcast time)',
};

/** Describe the raw catalog fields available for the clip or an airing. */
const rawFields = {
	title: 'Raw item title', subtitle: 'Raw subtitle (usually blank)', kind: 'episode', seriesTitle: 'The Alpine Expedition',
	seasonNumber: '1', episodeNumber: '3', episodeEndNumber: '4', year: '2026', releaseDate: '2026-01-01',
	description: 'Catalog synopsis', durationSeconds: '1800',
};

/** Liquid fields shown in the insertion picker. */
const fields = [
	{ name: 'channel.name', value: 'Moirai TV' }, { name: 'channel.number', value: '12' },
	...['now', 'next', 'upcoming[0]'].flatMap(scope => Object.entries(airingFields).map(([field, value]) => ({ name: `${scope}.${field}`, value }))),
	...['media', 'now.media', 'next.media', 'upcoming[0].media'].flatMap(scope => Object.entries(rawFields)
		.map(([field, value]) => ({ name: `${scope}.${field}`, value }))),
];

const hasDependents = computed(() => props.layers.some(layer => layer.attachment?.layerId === props.layer.id));
const targets = computed(() => props.layers.filter(candidate => {
	let target: GraphicsLayer | undefined = candidate;
	while (target) {
		if (target.id === props.layer.id || target.kind === 'clock') {
			return false;
		}
		const parent: string | undefined = target.attachment?.layerId;
		target = parent ? props.layers.find(layer => layer.id === parent) : undefined;
	}
	return true;
}));

/** Store a nonempty name or remove the optional YAML field. */
function renameLayer(event: Event): void {
	const input = event.target as HTMLInputElement;
	const name = input.value.trim();
	input.value = name;
	emit('patch', { name: name || undefined });
}

/** Attach to a new target using the layer's current anchor for both points. */
function setTarget(id: string): void {
	emit('patch', { attachment: id ? { layerId: id, anchor: props.layer.anchor, offsetX: 0, offsetY: 0 } : undefined });
}

/** Read bounded numeric geometry from a form control. */
function boundedNumber(event: Event, min: number, max: number): number {
	return Math.max(min, Math.min(max, Number((event.target as HTMLInputElement).value)));
}

/** Set one timing value while keeping the authored appearance valid. */
function timingValue(key: string, value: number | string | undefined): void {
	const timing = props.layer.timing;
	if (timing.mode === 'always') {
		return;
	}

	const next = { ...timing, [key]: value };
	if (next.mode === 'periodic') {
		const maximum = 86_400_000;
		next.phase = Math.min(next.phase, maximum - 1);
		next.fade = Math.min(next.fade, Math.floor(maximum / 3));
		next.hold = Math.min(next.hold, maximum - 2 * next.fade);
	}
	next.hold = Math.max(next.hold, next.fade, 1);
	if (next.mode === 'periodic') {
		next.frequency = Math.max(next.frequency, next.hold + 2 * next.fade, next.phase + 1);
	}
	emit('patch', { timing: next });
}

/** Supply immediately valid defaults when choosing another visibility mode. */
function setMode(mode: string): void {
	const appearance = { phase: 0, fade: 1000, hold: 6000 };
	emit('patch', { timing: mode === 'always' ? { mode } : mode === 'once' ? { mode, ...appearance }
		: { mode, ...appearance, frequency: 60_000, clock: 'content' } });
}

/** Insert a supported Liquid field in the text layer. */
function insertField(field: string): void {
	if (props.layer.kind === 'text') {
		const text = `${props.layer.text} {{ ${field} }}`;
		if (text.length <= MAX_GRAPHICS_TEXT_LENGTH) {
			emit('patch', { text });
		}
	}
}

/** Add a named inline style inheriting the current base values. */
function addStyle(): void {
	const name = styleName.value.trim();
	if (props.layer.kind === 'text' && /^[a-z][a-z0-9_-]{0,31}$/.test(name) && !Object.hasOwn(props.layer.styles ?? {}, name)
		&& Object.keys(props.layer.styles ?? {}).length < 12) {
		emit('patch', { styles: { ...props.layer.styles, [name]: { ...props.layer.style } } });
		styleName.value = '';
	}
}

/** Update one text style, retaining the rest of the style map. */
function patchStyle(name: string, key: string, value: unknown): void {
	if (props.layer.kind !== 'text') {
		return;
	}
	const prior = name ? props.layer.styles?.[name] : props.layer.style;
	if (prior) {
		const updated = { ...prior, [key]: value };
		emit('patch', name ? { styles: { ...props.layer.styles, [name]: updated } } : { style: updated });
	}
}

/** Wrap the selected text in the named style and return focus to the text editor. */
async function applyStyle(name: string): Promise<void> {
	const input = textInput.value;
	if (!input || props.layer.kind !== 'text') {
		return;
	}
	const { selectionStart: start, selectionEnd: end } = input;
	const text = props.layer.text;
	const opening = `[${name}]`;
	const styled = text.slice(0, start) + opening + text.slice(start, end) + `[/${name}]` + text.slice(end);
	if (styled.length > MAX_GRAPHICS_TEXT_LENGTH) {
		return;
	}
	emit('patch', { text: styled });
	await nextTick();
	input.focus();
	input.setSelectionRange(start + opening.length, end + opening.length);
}

/** Remove a draft-local style after confirmation. */
function removeStyle(name: string): void {
	if (props.layer.kind === 'text') {
		const styles = { ...props.layer.styles };
		delete styles[name];
		emit('patch', { styles });
	}
}
/** Normalize a numeric shape property to its editable pixel range. */
function patchShapeNumber(key: 'width' | 'height' | 'radius' | 'strokeWidth', event: Event): void {
	if (props.layer.kind !== 'shape') {
		return;
	}
	const input = event.target as HTMLInputElement;
	const value = Math.max(Number(input.min), Math.min(Number(input.max), Math.round(Number(input.value))));
	emit('patch', { shape: { ...props.layer.shape, [key]: value } });
}

/** Enable a fade from the current solid color, or return to the stored solid fill. */
function setFillMode(event: Event): void {
	if (props.layer.kind !== 'shape') {
		return;
	}
	const shape = props.layer.shape;
	const gradient = (event.target as HTMLSelectElement).value === 'gradient'
		? { angle: 90, start: { color: shape.fill, opacity: 100 }, end: { color: shape.fill, opacity: 0 } }
		: undefined;
	emit('patch', { shape: { ...shape, gradient } });
}

/** Update one endpoint without changing its other property or the opposite endpoint. */
function patchGradientStop(stop: 'start' | 'end', change: { color: string } | { opacity: number }): void {
	if (props.layer.kind === 'shape' && props.layer.shape.gradient) {
		const { shape } = props.layer;
		const gradient = shape.gradient!;
		emit('patch', { shape: { ...shape, gradient: { ...gradient, [stop]: { ...gradient[stop], ...change } } } });
	}
}
</script>

<template>
	<fieldset class="graphics-inspector form-grid" :disabled="disabled">
		<legend>{{ { media: 'Media', text: 'Text', shape: 'Shape', clock: 'Clock' }[layer.kind] }} layer settings</legend>
		<label class="graphics-full-row graphics-inspector-inline">
			<span>Layer name</span>
			<input type="text" :value="layer.name ?? ''" :maxlength="MAX_GRAPHICS_LAYER_NAME_LENGTH" placeholder="Optional" @change="renameLayer" />
		</label>
		<div v-if="layer.kind === 'media'" class="graphics-media-picker">
			<div class="graphics-media-picker-row">
				<GraphicsPicker :model-value="layer.assetId" label="Media" :options="mediaAssets" :disabled="disabled" @update:model-value="emit('patch', { assetId: $event })">
					<template #default="{ option, animated }">
						<GraphicsMediaThumbnail :key="option.id" :asset="option" :animated="animated" />
						<span class="graphics-picker-name">{{ option.name }}</span>
					</template>
				</GraphicsPicker>
				<template v-if="!disabled">
					<input ref="mediaInput" type="file" accept=".png,.apng,.jpeg,.jpg,.gif,.webp,.webm,.mp4" hidden @change="emit('uploadMedia', $event, layer.id)" />
					<button type="button" class="button secondary graphics-media-upload" aria-label="Upload media" title="Upload media" @click="mediaInput?.click()"><Upload :size="16" aria-hidden="true" /></button>
				</template>
			</div>
		</div>
		<fieldset v-if="layer.kind === 'shape'" class="graphics-settings-group form-grid graphics-full-row">
			<legend>Shape</legend>
			<label class="graphics-inspector-inline"><span>Type</span><select :value="layer.shape.primitive" @change="emit('patch', { shape: { ...layer.shape, primitive: ($event.target as HTMLSelectElement).value } })">
				<option v-for="primitive in graphicsShapes" :key="primitive" :value="primitive">{{ { rectangle: 'Rectangle', roundedRectangle: 'Rounded rectangle', ellipse: 'Ellipse', line: 'Line' }[primitive] }}</option>
			</select></label>
			<div class="graphics-property-row">
				<label v-for="[key, label, min, max] in [['width', 'Width', 1, 1920], ['height', 'Height', 1, 1080], ['radius', 'Radius', 0, 540]] as const" v-show="key !== 'radius' || layer.shape.primitive === 'roundedRectangle'" :key="key">
					<span>{{ label }} (px)</span><input type="number" :min="min" :max="max" :value="layer.shape[key]" @change="patchShapeNumber(key, $event)" />
				</label>
			</div>
			<template v-if="layer.shape.primitive !== 'line'">
				<label class="graphics-inspector-inline"><span>Fill mode</span><select :value="layer.shape.gradient ? 'gradient' : 'solid'" @change="setFillMode">
					<option value="solid">Solid</option>
					<option value="gradient">Linear gradient</option>
				</select></label>
				<template v-if="layer.shape.gradient">
					<div class="graphics-gradient-swatch" aria-hidden="true">
						<div :style="{ background: gradientSwatch }"></div>
					</div>
					<div v-for="stop in (['start', 'end'] as const)" :key="stop" class="graphics-property-row">
						<label><span>{{ stop === 'start' ? 'Start color' : 'End color' }}</span><input type="color" :value="layer.shape.gradient[stop].color" @change="patchGradientStop(stop, { color: ($event.target as HTMLInputElement).value })" /></label>
						<label><span>{{ stop === 'start' ? 'Start opacity (%)' : 'End opacity (%)' }}</span><input type="number" min="0" max="100" step="any" :value="layer.shape.gradient[stop].opacity" @change="patchGradientStop(stop, { opacity: boundedNumber($event, 0, 100) })" /></label>
					</div>
					<label><span>Angle (°)</span><input type="number" min="0" max="360" step="any" :value="layer.shape.gradient.angle" @change="emit('patch', { shape: { ...layer.shape, gradient: { ...layer.shape.gradient, angle: boundedNumber($event, 0, 360) } } })" /></label>
				</template>
				<label v-else><span>Fill</span><input type="color" :value="layer.shape.fill" @change="emit('patch', { shape: { ...layer.shape, fill: ($event.target as HTMLInputElement).value } })" /></label>
			</template>
			<div class="graphics-property-row">
				<label><span>Stroke</span><input type="color" :value="layer.shape.stroke" @change="emit('patch', { shape: { ...layer.shape, stroke: ($event.target as HTMLInputElement).value } })" /></label>
				<label><span>Stroke (px)</span><input type="number" min="0" max="64" :value="layer.shape.strokeWidth" @change="patchShapeNumber('strokeWidth', $event)" /></label>
			</div>
		</fieldset>
		<fieldset v-if="layer.kind === 'clock'" class="graphics-settings-group form-grid graphics-full-row">
			<legend>Clock badge</legend>
			<div class="graphics-property-row">
				<label v-for="[key, label] in [['color', 'Digit color'], ['background', 'Background color']] as const" :key="key">
					<span>{{ label }}</span><input type="color" :value="layer.badge[key]" @change="emit('patch', { badge: { ...layer.badge, [key]: ($event.target as HTMLInputElement).value } })" />
				</label>
				<label><span>Background opacity (%)</span><input type="number" min="0" max="100" step="any" :value="layer.badge.backgroundOpacity" @change="emit('patch', { badge: { ...layer.badge, backgroundOpacity: boundedNumber($event, 0, 100) } })" /></label>
			</div>
		</fieldset>
		<template v-if="layer.kind === 'text'">
			<fieldset class="graphics-settings-group form-grid graphics-full-row">
				<legend>Text</legend>
				<label class="graphics-full-row"><span>Text or Liquid template</span><textarea ref="textInput" :value="layer.text" :maxlength="MAX_GRAPHICS_TEXT_LENGTH" rows="2" @input="emit('patch', { text: ($event.target as HTMLTextAreaElement).value })" /></label>
				<div class="form-actions graphics-full-row">
					<button type="button" class="button secondary" @click="fieldPicker?.show($event.currentTarget as HTMLElement)">Insert Liquid field</button>
					<GuideTemplateValuesPopover ref="fieldPicker" title="Graphics template fields" :values="fields" insertable @insert="insertField" />
				</div>
			</fieldset>
			<fieldset class="graphics-settings-group form-grid graphics-full-row">
				<legend>Styles</legend>
				<component :is="name ? 'details' : 'div'" v-for="(style, name) in { '': layer.style, ...layer.styles }" :key="name" class="graphics-style">
					<summary v-if="name">{{ `[${name}]…[/${name}]` }}</summary>
					<div class="graphics-property-row graphics-font-fields">
						<label><span>Font</span><select :value="style.fontId ?? ''" @change="patchStyle(name, 'fontId', ($event.target as HTMLSelectElement).value || undefined)">
							<option value="">System Sans</option><option v-for="asset in assets.filter(item => item.kind === 'font')" :key="asset.id" :value="asset.id">{{ asset.name }}</option>
						</select></label>
						<label><span>Size</span><input type="number" min="8" max="192" :value="style.size" @change="patchStyle(name, 'size', Math.max(8, Math.min(192, Math.round(Number(($event.target as HTMLInputElement).value)))))" /></label>
						<label><span>Color</span><input type="color" :value="style.color" @change="patchStyle(name, 'color', ($event.target as HTMLInputElement).value)" /></label>
					</div>
					<div class="graphics-style-flags">
						<label class="graphics-checkbox"><input type="checkbox" :checked="style.bold" @change="patchStyle(name, 'bold', ($event.target as HTMLInputElement).checked)" /> Bold</label>
						<label class="graphics-checkbox"><input type="checkbox" :checked="style.italic" @change="patchStyle(name, 'italic', ($event.target as HTMLInputElement).checked)" /> Italic</label>
					</div>
					<button v-if="name" type="button" class="button secondary" @click="applyStyle(name)">Apply to selected text</button>
					<TwoStepActionButton v-if="name" class="button secondary" label="Remove style" confirm-label="Confirm remove style" @confirm="removeStyle(name)">Remove style</TwoStepActionButton>
				</component>
				<div class="form-actions graphics-full-row"><input v-model="styleName" aria-label="New style name" placeholder="Style name" maxlength="32" /><button type="button" class="button secondary" @click="addStyle">Add style</button></div>
			</fieldset>
		</template>
		<fieldset class="graphics-settings-group form-grid graphics-full-row">
			<legend>Layout</legend>
			<label v-if="layer.kind !== 'clock'" class="graphics-inspector-inline"><span>Anchor to</span>
				<select :value="layer.attachment?.layerId ?? ''" @change="setTarget(($event.target as HTMLSelectElement).value)">
					<option value="">Frame or source</option>
					<option v-for="target in targets" :key="target.id" :value="target.id">Layer {{ layers.indexOf(target) + 1 }} · {{ target.name ?? target.kind }}</option>
				</select>
			</label>
			<div class="graphics-placement">
				<fieldset class="graphics-anchors">
					<legend>Anchor</legend>
					<div class="graphics-anchor-grid">
						<label v-for="anchor in graphicsAnchors" :key="anchor" :title="anchor.replaceAll('_', ' ')">
							<input type="radio" :name="anchorGroup" :value="anchor" :checked="layer.anchor === anchor" :aria-label="anchor.replaceAll('_', ' ')" @change="emit('patch', { anchor })" />
							<span aria-hidden="true"></span>
						</label>
					</div>
				</fieldset>
				<fieldset v-if="layer.attachment" class="graphics-placement-margins graphics-attachment-fields">
					<legend>Attachment</legend>
					<label><span>Target anchor</span>
						<select :value="layer.attachment.anchor" @change="emit('patch', { attachment: { ...layer.attachment, anchor: ($event.target as HTMLSelectElement).value } })">
							<option v-for="anchor in graphicsAnchors" :key="anchor" :value="anchor">{{ anchor.replaceAll('_', ' ') }}</option>
						</select>
					</label>
					<div class="graphics-property-row">
						<label v-for="[key, label] in [['offsetX', 'Horizontal offset (%)'], ['offsetY', 'Vertical offset (%)']] as const" :key="key">
							<span>{{ label }}</span><input type="number" min="-100" max="100" step="any" :value="layer.attachment[key]" @change="emit('patch', { attachment: { ...layer.attachment, [key]: boundedNumber($event, -100, 100) } })" />
						</label>
					</div>
				</fieldset>
				<fieldset v-if="!layer.attachment" class="graphics-placement-margins">
					<legend>Margins (%)</legend>
					<div class="graphics-property-row">
						<label v-for="[key, label] in [['horizontalMargin', 'Horizontal'], ['verticalMargin', 'Vertical']] as const" :key="key">
							<span>{{ label }}</span><input type="number" :aria-label="`${label} margin (%)`" min="0" max="100" step="any" :value="layer[key]" @change="emit('patch', { [key]: Math.max(0, Math.min(100, Number(($event.target as HTMLInputElement).value))) })" />
						</label>
					</div>
				</fieldset>
			</div>
			<div class="graphics-size-controls">
				<label v-for="[key, label] in [['width', 'Width (%)'], ['opacity', 'Opacity (%)']] as const" :key="key">
					<span>{{ label }}</span><input type="number" :min="key === 'width' ? (layer.kind === 'clock' ? 4 : 1) : 0" :max="key === 'width' && layer.kind === 'clock' ? 25 : 100" step="any" :placeholder="key === 'width' ? 'Original size' : undefined" :value="layer[key]" @change="emit('patch', { [key]: ($event.target as HTMLInputElement).value === '' && key === 'width' && layer.kind !== 'clock' ? undefined : boundedNumber($event, Number(($event.target as HTMLInputElement).min), Number(($event.target as HTMLInputElement).max)) })" />
				</label>
				<label v-if="!layer.attachment" class="graphics-checkbox" title="Align within source picture"><input type="checkbox" aria-label="Align within source picture" :checked="layer.withinSource" @change="emit('patch', { withinSource: ($event.target as HTMLInputElement).checked })" /> <span aria-hidden="true">Align</span></label>
			</div>
			<div v-if="layer.kind !== 'clock'" class="graphics-property-row">
				<label><span>Rotation (°)</span><input type="number" min="-180" max="180" step="any" :value="layer.rotation ?? 0" @change="emit('patch', { rotation: boundedNumber($event, -180, 180) })" /></label>
				<template v-if="layer.kind === 'shape'">
					<label v-for="[key, label] in [['skewX', 'Skew X (°)'], ['skewY', 'Skew Y (°)']] as const" :key="key">
						<span>{{ label }}</span><input type="number" min="-40" max="40" step="any" :value="layer.shape[key] ?? 0" @change="emit('patch', { shape: { ...layer.shape, [key]: boundedNumber($event, -40, 40) } })" />
					</label>
				</template>
			</div>
		</fieldset>
		<fieldset v-if="layer.kind !== 'clock'" class="graphics-settings-group form-grid graphics-full-row">
			<legend>Visibility and timing</legend>
			<label class="graphics-inspector-inline"><span>Visibility</span><select :value="layer.timing.mode" @change="setMode(($event.target as HTMLSelectElement).value)">
				<option value="always">Always</option><option value="once">Once per playout item</option><option value="periodic">Periodic</option>
			</select></label>
			<div v-if="layer.timing.mode !== 'always'" class="graphics-property-row">
				<label v-for="[key, label] in [['phase', 'Delay or phase (ms)'], ['fade', 'Each fade (ms)'], ['hold', 'Hold (ms)']] as const" :key="key">
					<span>{{ label }}</span><input type="number" :min="key === 'fade' ? MIN_GRAPHICS_FADE_MS : 0" max="86400000" :value="layer.timing[key]" @change="timingValue(key, Math.max(key === 'fade' ? MIN_GRAPHICS_FADE_MS : 0, Math.min(86_400_000, Math.round(Number(($event.target as HTMLInputElement).value)))))" />
				</label>
			</div>
			<div v-if="layer.timing.mode === 'periodic'" class="graphics-property-row">
				<label><span>Clock</span><select :value="layer.timing.clock" @change="timingValue('clock', ($event.target as HTMLSelectElement).value)"><option value="content">Content</option><option value="wall">Wall clock</option></select></label>
				<label><span>Cycle length (ms)</span><input type="number" min="1" max="86400000" :value="layer.timing.frequency" @change="timingValue('frequency', Math.max(1, Math.min(86_400_000, Math.round(Number(($event.target as HTMLInputElement).value)))))" /></label>
				<label><span>Stop starting appearances after (ms)</span><input type="number" min="1" max="86400000" :value="layer.timing.cutoff" @change="timingValue('cutoff', ($event.target as HTMLInputElement).value ? Math.max(1, Math.min(86_400_000, Math.round(Number(($event.target as HTMLInputElement).value)))) : undefined)" /></label>
			</div>
		</fieldset>

		<p v-if="hasDependents" class="graphics-full-row">Reassign attached layers before removing this layer.</p>
	</fieldset>
</template>
