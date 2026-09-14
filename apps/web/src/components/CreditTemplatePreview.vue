<script setup lang="ts">
import { liveEvents } from '../live-events';
import { useLibrariesStore } from '../stores/libraries';
import { RouterLink } from 'vue-router';
import { useDisclosureState } from '../disclosure-state';
import { computed, nextTick, onMounted, onBeforeUnmount, ref, watch } from 'vue';
import type { CreditPreviewResult, MediaItem } from '@moirai/shared';
import { api } from '../api';
import { errorMessage } from '../error-message';
import { Film } from '@lucide/vue';
import { artworkVariantUrl } from '../artwork-url';
import LoadingState from './LoadingState.vue';

const sourceOpen = useDisclosureState('credit-preview-source');

const props = defineProps<{ source: string }>();
const emit = defineEmits<{ busy: [value: boolean] }>();
const items = ref<MediaItem[]>([]);
const itemId = ref('');
const seconds = ref(10);
const selectedItem = computed(() => items.value.find(item => item.id === itemId.value));
const duration = computed(() => selectedItem.value?.durationSeconds ?? 0);
const validTime = computed(() => Number.isFinite(seconds.value) && seconds.value >= 0 && seconds.value <= 86400 && seconds.value < duration.value);
const loaded = ref(false);
const loading = ref(false);
const rendering = ref(false);
const loadError = ref('');
const error = ref('');
const preview = ref<CreditPreviewResult>();
const previewFrame = ref<HTMLElement>();
const previewVisible = computed(() => rendering.value || Boolean(preview.value) || Boolean(error.value));
let previewSequence = 0;
let loadSequence = 0;
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
const librariesStore = useLibrariesStore();

/** Bring the reserved image area into the editor viewport without moving keyboard focus. */
function revealPreview(): void {
	const frame = previewFrame.value;
	const scroll = frame?.closest<HTMLElement>('.resource-editor-scroll');
	if (!frame || !scroll) {
		return;
	}
	scroll.scrollTo({ top: scroll.scrollTop + frame.getBoundingClientRect().top - scroll.getBoundingClientRect().top - 12,
		behavior: 'instant' });
}

/** Refresh the bounded video sample while retaining the selected video when it remains available. */
async function load(): Promise<void> {
	const request = ++loadSequence;
	loading.value = !loaded.value;
	loadError.value = '';
	try {
		const result = await api.creditPreviewVideos();
		if (request !== loadSequence) {
			return;
		}
		items.value = result;
		if (!items.value.some(item => item.id === itemId.value)) {
			itemId.value = items.value[0]?.id ?? '';
		}
		loaded.value = true;
	}
	catch (cause) {
		if (request === loadSequence) {
			loadError.value = errorMessage(cause);
		}
	}
	finally {
		if (request === loadSequence) {
			loading.value = false;
		}
	}
}

/** Render the current draft and retain errors beside the preview controls. */
async function render(): Promise<void> {
	if (rendering.value || !validTime.value) {
		return;
	}
	const wasVisible = previewVisible.value;
	const token = ++previewSequence;
	rendering.value = true;
	emit('busy', true);
	error.value = '';
	preview.value = undefined;
	await nextTick();
	if (wasVisible) {
		revealPreview();
	}
	try {
		const result = await api.previewCreditTemplate({ source: props.source, mediaItemId: itemId.value, seconds: seconds.value });
		const image = new Image();
		image.src = result.image;
		await image.decode();
		if (token === previewSequence) {
			preview.value = result;
		}
	}
	catch (cause) {
		if (token === previewSequence) {
			error.value = errorMessage(cause);
		}
	}
	finally {
		rendering.value = false;
		emit('busy', false);
	}
}
watch([itemId, duration], () => {
	if (duration.value > 0 && seconds.value >= duration.value) {
		seconds.value = Math.min(10, duration.value / 2);
	}
	error.value = '';
});
watch([() => props.source, itemId, seconds], () => {
	previewSequence++;
	preview.value = undefined; 
});
const unsubscribe = liveEvents.subscribe((event) => {
	if (event.type !== 'scan.changed' || !['complete', 'partial'].includes(event.data.status)) {
		return;
	}
	const library = librariesStore.libraries.find(entry => entry.id === event.data.libraryId);
	if (library && library.typeKey !== 'music-videos') {
		return;
	}
	clearTimeout(refreshTimer);
	refreshTimer = setTimeout(() => void load(), 180);
});
onMounted(load);
onBeforeUnmount(() => {
	unsubscribe();
	clearTimeout(refreshTimer);
	loadSequence++;
	previewSequence++;
});
</script>

<template>
	<section class="credit-preview">
		<h3>Preview on a music video</h3>
		<p class="muted">Uses the default encoding profile and installed system fonts.</p>
		<LoadingState v-if="loading" label="Loading music videos…" />
		<p v-else-if="loadError" class="notice error">{{ loadError }} <button class="button secondary" type="button" @click="load">Retry</button></p>
		<template v-else-if="loaded">
			<p v-if="!items.length">Add and scan a music video library to preview credits. <button class="button secondary contextual" type="button" @click="load">Refresh videos</button> <RouterLink v-if="selectedItem" :to="`/libraries/${selectedItem.libraryId}/items/${selectedItem.id}`">Inspect video</RouterLink></p>
			<template v-else>
				<div class="credit-preview-videos" role="group" aria-label="Music videos">
					<button v-for="item in items" :key="item.id" class="credit-preview-video" type="button" :aria-pressed="itemId === item.id" :disabled="rendering" @click="itemId = item.id">
						<img v-if="item.artworkUrl" :src="artworkVariantUrl(item.artworkUrl, 'card')" alt="" loading="lazy" />
						<span v-else class="credit-preview-video-placeholder"><Film :size="28" aria-hidden="true" /></span>
						<strong>{{ item.title }}</strong><small>{{ item.artists.join(', ') }}</small>
					</button>
				</div>
				<p v-if="duration <= 0" class="notice warning">Video duration is unavailable. Inspect the video’s metadata and scan issues, or refresh after scanning. <button class="button secondary contextual" type="button" @click="load">Refresh videos</button> <RouterLink v-if="selectedItem" :to="`/libraries/${selectedItem.libraryId}/items/${selectedItem.id}`">Inspect video</RouterLink></p>
				<div class="credit-preview-actions">
					<label><span>Source time (seconds)</span><input v-model.number="seconds" :disabled="rendering" type="number" inputmode="decimal" min="0" max="86400" step="0.1" /></label>
					<button class="button secondary" type="button" :disabled="rendering || !itemId || !validTime" @click="render">{{ rendering ? 'Rendering…' : 'Render preview' }}</button>
				</div>
			</template>
		</template>
		<Transition name="credit-preview-reveal" @after-enter="revealPreview">
			<div v-if="previewVisible" class="credit-preview-result">
				<div class="credit-preview-result-content">
					<div ref="previewFrame" class="credit-preview-frame" :aria-busy="rendering">
						<LoadingState v-if="rendering" label="Rendering credit preview…" />
						<p v-else-if="error" class="notice error" role="alert">{{ error }}</p>
						<Transition name="credit-preview-image" appear>
							<img v-if="preview" :src="preview.image" alt="Music video frame with the generated credits" />
						</Transition>
					</div>
					<details v-if="preview" :open="sourceOpen" @toggle="sourceOpen = ($event.target as HTMLDetailsElement).open"><summary>Generated subtitles (.ass)</summary><pre>{{ preview.ass }}</pre></details>
				</div>
			</div>
		</Transition>
	</section>
</template>
