<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from 'vue';
import { Asterisk, Info } from '@lucide/vue';
import { useRoute } from 'vue-router';
import type { MediaCardPreview } from '@moirai/shared';
import { artworkSrcset, artworkVariantUrl } from '../artwork-url';
import { hideBrokenImage } from '../image-error';
import { loadMediaCardPreview, mediaCardPreviewPosition } from '../media-card-preview';
import { randomUuid } from '../random-uuid';

/** Basic card fields rendered immediately while richer indexed metadata loads. */
export interface MediaCardPreviewSource {
	id: string;
	title: string;
	year: number | null;
	plot?: string | null;
	artworkUrl: string | null;
}

const props = defineProps<{ item: MediaCardPreviewSource }>();
const route = useRoute();
const anchor = ref<HTMLElement>();
const tooltip = ref<HTMLElement>();
const preview = ref<MediaCardPreview>();
const visible = ref(false);
const pinned = ref(false);
const loading = ref(false);
const position = ref({ left: 12, top: 12 });
const tooltipId = `media-card-preview-${randomUuid()}`;
const previewOpenEvent = 'moirai-media-card-preview-open';
let hoverTimer: ReturnType<typeof setTimeout> | undefined;

const display = computed<MediaCardPreview>(() => preview.value ?? {
	id: props.item.id,
	title: props.item.title,
	year: props.item.year,
	plot: props.item.plot ?? null,
	artworkUrl: props.item.artworkUrl,
	rating: null,
	primaryGenre: null,
	actors: [],
});

/** Return whether this browser provides a conventional accurate hover pointer. */
function supportsHover(): boolean {
	return window.matchMedia('(hover: hover) and (pointer: fine)').matches;
}

/** Reposition the fixed tooltip after its contents or viewport geometry changes. */
function updatePosition(): void {
	if (!anchor.value || !tooltip.value) {
		return;
	}

	const anchorBox = anchor.value.getBoundingClientRect();
	const tooltipBox = tooltip.value.getBoundingClientRect();
	position.value = mediaCardPreviewPosition({
		anchor: anchorBox,
		previewWidth: tooltipBox.width,
		previewHeight: tooltipBox.height,
		viewportWidth: window.innerWidth,
		viewportHeight: window.innerHeight,
	});
}

/** Fetch rich indexed metadata once while keeping the basic card preview visible. */
async function loadPreview(): Promise<void> {
	if (preview.value || loading.value) {
		return;
	}

	loading.value = true;
	try {
		preview.value = await loadMediaCardPreview(props.item.id);
	}
	catch {
		// Basic card metadata remains useful when the optional preview request fails.
	}
	finally {
		loading.value = false;
		await nextTick();
		updatePosition();
	}
}

/** Show one preview immediately and optionally keep it open for touch interaction. */
function showPreview(keepOpen = false): void {
	if (hoverTimer !== undefined) {
		clearTimeout(hoverTimer);
		hoverTimer = undefined;
	}

	document.dispatchEvent(new CustomEvent(previewOpenEvent, { detail: tooltipId }));
	pinned.value = keepOpen;
	visible.value = true;
	void nextTick().then(updatePosition);
	void loadPreview();
}

/** Close one preview unless a touch or keyboard action pinned it. */
function hidePreview(force = false): void {
	if (hoverTimer !== undefined) {
		clearTimeout(hoverTimer);
		hoverTimer = undefined;
	}
	if (pinned.value && !force) {
		return;
	}

	pinned.value = false;
	visible.value = false;
}

/** Delay fine-pointer previews so cards crossed incidentally do not issue requests. */
function handlePointerEnter(event: PointerEvent): void {
	if (event.pointerType !== 'mouse' || !supportsHover() || pinned.value) {
		return;
	}

	hoverTimer = setTimeout(() => showPreview(), 300);
}

/** Hide an unpinned pointer preview after leaving its card. */
function handlePointerLeave(): void {
	hidePreview();
}

/** Expose the same information when an interactive card or its info control receives focus. */
function handleFocus(): void {
	showPreview(pinned.value);
}

/** Close after keyboard focus leaves the complete card wrapper. */
function handleBlur(event: FocusEvent): void {
	if (event.relatedTarget instanceof Node && anchor.value?.contains(event.relatedTarget)) {
		return;
	}

	hidePreview();
}

/** Toggle a pinned preview without activating the underlying card. */
function togglePinned(): void {
	if (pinned.value) {
		hidePreview(true);
		return;
	}

	showPreview(true);
}

/** Close pinned previews when another part of the document is pressed. */
function handleDocumentPointer(event: PointerEvent): void {
	if (pinned.value && event.target instanceof Node && !anchor.value?.contains(event.target)) {
		hidePreview(true);
	}
}

/** Close any visible preview through the standard Escape interaction. */
function handleKeydown(event: KeyboardEvent): void {
	if (event.key === 'Escape' && visible.value) {
		hidePreview(true);
	}
}

/** Close this tooltip when any other media card begins opening its preview. */
function handleOtherPreviewOpen(event: Event): void {
	if (event instanceof CustomEvent && event.detail !== tooltipId) {
		hidePreview(true);
	}
}

watch(visible, (isVisible) => {
	if (isVisible) {
		window.addEventListener('resize', updatePosition);
		window.addEventListener('scroll', updatePosition, true);
		document.addEventListener('pointerdown', handleDocumentPointer);
		document.addEventListener('keydown', handleKeydown);
		document.addEventListener(previewOpenEvent, handleOtherPreviewOpen);
	}
	else {
		window.removeEventListener('resize', updatePosition);
		window.removeEventListener('scroll', updatePosition, true);
		document.removeEventListener('pointerdown', handleDocumentPointer);
		document.removeEventListener('keydown', handleKeydown);
		document.removeEventListener(previewOpenEvent, handleOtherPreviewOpen);
	}
});
watch(() => route.fullPath, () => hidePreview(true));
onUnmounted(() => {
	hidePreview(true);
	window.removeEventListener('resize', updatePosition);
	window.removeEventListener('scroll', updatePosition, true);
	document.removeEventListener('pointerdown', handleDocumentPointer);
	document.removeEventListener('keydown', handleKeydown);
	document.removeEventListener(previewOpenEvent, handleOtherPreviewOpen);
});
</script>

<template>
	<div
		ref="anchor"
		class="media-card-preview-trigger"
		:class="{ 'preview-visible': visible }"
		@pointerenter="handlePointerEnter"
		@pointerleave="handlePointerLeave"
		@focusin="handleFocus"
		@focusout="handleBlur"
	>
		<slot></slot>
		<button
			type="button"
			class="media-card-preview-info"
			:aria-label="`Preview ${item.title}`"
			:aria-expanded="pinned"
			:aria-describedby="visible ? tooltipId : undefined"
			@click.stop.prevent="togglePinned"
		>
			<Info :size="15" />
		</button>
		<Teleport to="body">
			<aside
				v-if="visible"
				:id="tooltipId"
				ref="tooltip"
				class="media-card-preview-tooltip"
				role="tooltip"
				:style="{ left: `${position.left}px`, top: `${position.top}px` }"
			>
				<div class="media-card-preview-poster">
					<Asterisk :size="32" />
					<img
						v-if="display.artworkUrl"
						:src="artworkVariantUrl(display.artworkUrl, 'card')"
						:srcset="artworkSrcset(display.artworkUrl, 'card')"
						alt=""
						decoding="async"
						@error="hideBrokenImage"
					/>
				</div>
				<div class="media-card-preview-copy">
					<h3>{{ display.title }}</h3>
					<div class="media-card-preview-facts">
						<span v-if="display.year">{{ display.year }}</span>
						<span v-if="display.rating !== null">★ {{ display.rating.toFixed(1) }}</span>
						<span v-if="display.primaryGenre">{{ display.primaryGenre }}</span>
					</div>
					<p v-if="display.plot" class="media-card-preview-plot">{{ display.plot }}</p>
					<p v-else-if="loading" class="media-card-preview-loading">Loading details…</p>
					<p v-if="display.actors.length" class="media-card-preview-actors">
						<strong>Starring</strong> {{ display.actors.join(', ') }}
					</p>
				</div>
			</aside>
		</Teleport>
	</div>
</template>
