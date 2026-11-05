<script lang="ts">
/** Serialize gallery requests because Next admits one preview render at a time. */
let sampleQueue = Promise.resolve();
</script>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { Play } from '@lucide/vue';
import type { GraphicsAsset, GraphicsLayer } from '@moirai/shared';
import { request } from '../../api';
import { errorMessage } from '../../error-message';
import GraphicsCanvas from './GraphicsCanvas.vue';

const props = defineProps<{
	presetId: string; layers: GraphicsLayer[]; assets: GraphicsAsset[]; elapsedMs: number; enabled: boolean;
}>();
const stage = ref<HTMLElement>();
const source = ref('');
const playButton = ref<HTMLButtonElement>();
const playbackButton = ref<HTMLButtonElement>();
const video = ref<HTMLVideoElement>();
const playing = ref(false);
const loading = ref(false);
const error = ref('');
const visible = ref(false);
const foreground = ref(true);
const reducedMotion = ref(false);
const optedIn = ref(false);
const canPlay = computed(() => props.enabled && visible.value && foreground.value && (!reducedMotion.value || optedIn.value));
let observer: IntersectionObserver | undefined;
let motionPreference: MediaQueryList | undefined;

/** Synchronize with the browser's current reduced-motion preference. */
function updateMotionPreference(): void {
	reducedMotion.value = motionPreference?.matches ?? false;
}

/** Suspend samples when the browser tab is hidden. */
function updateForeground(): void {
	foreground.value = document.visibilityState === 'visible';
}

/** Remove the offscreen player and release its browser-side clip buffer. */
function release(): void {
	if (source.value) {
		URL.revokeObjectURL(source.value);
		source.value = '';
	}
}

/** Fetch a clip when this card reaches the front of the queue and is still visible. */
async function loadSample(): Promise<void> {
	try {
		if (!canPlay.value) {
			return;
		}
		const clip = await request(`/api/v1/graphics/presets/${props.presetId}/sample-clip`, undefined, response => response.blob());
		if (canPlay.value) {
			const restoreFocus = document.activeElement === playButton.value;
			source.value = URL.createObjectURL(clip);
			if (restoreFocus) {
				await nextTick();
				playbackButton.value?.focus();
			}
		}
	}
	catch (cause) {
		if (canPlay.value) {
			error.value = errorMessage(cause);
		}
	}
	finally {
		loading.value = false;
	}
}

/** Queue one request per card, including when the operator retries a failed clip. */
function queueSample(): void {
	if (!canPlay.value || !props.layers.length || loading.value || source.value) {
		return;
	}
	loading.value = true;
	error.value = '';
	sampleQueue = sampleQueue.then(loadSample);
}

/** Honor an explicit play request when motion is disabled by preference. */
function play(): void {
	optedIn.value = true;
	queueSample();
}

/** Let the preview itself pause or resume without exposing the player toolbar. */
function togglePlayback(): void {
	if (video.value?.paused) {
		void video.value.play().catch(() => undefined);
	}
	else {
		video.value?.pause();
	}
}

/** Restore the layout preview when the browser cannot decode the clip. */
function playbackFailed(): void {
	release();
	error.value = 'The sample clip could not be played in this browser.';
}

onMounted(() => {
	motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');
	updateMotionPreference();
	motionPreference.addEventListener('change', updateMotionPreference);
	updateForeground();
	document.addEventListener('visibilitychange', updateForeground);
	observer = new IntersectionObserver(([entry]) => {
		visible.value = entry?.isIntersecting === true && entry.intersectionRatio >= 0.1;
	}, { threshold: 0.1 });
	if (stage.value) {
		observer.observe(stage.value);
	}
});
watch(canPlay, active => {
	if (active) {
		queueSample();
	}
	else {
		release();
	}
});
onBeforeUnmount(() => {
	visible.value = false;
	observer?.disconnect();
	motionPreference?.removeEventListener('change', updateMotionPreference);
	document.removeEventListener('visibilitychange', updateForeground);
	release();
});
</script>

<template>
	<div ref="stage" class="graphics-sample">
		<button v-if="source" ref="playbackButton" type="button" class="graphics-sample-toggle" :aria-label="playing ? 'Pause sample' : 'Resume sample'" :title="playing ? 'Pause sample' : 'Resume sample'" @click="togglePlayback">
			<video ref="video" :src="source" class="graphics-sample-video" aria-hidden="true" autoplay muted loop playsinline @play="playing = true" @pause="playing = false" @error="playbackFailed" />
		</button>
		<template v-else>
			<GraphicsCanvas :layers="layers" :assets="assets" :elapsed-ms="elapsedMs" thumbnail />
			<button v-if="layers.length && (error || reducedMotion || optedIn)" ref="playButton" type="button" class="button secondary graphics-sample-play" :aria-disabled="loading" @click="!loading && play()">
				<Play :size="15" aria-hidden="true" /><span aria-live="polite">{{ loading ? 'Preparing sample…' : 'Play sample' }}</span>
			</button>
		</template>
		<p v-if="error" class="notice error" role="alert">{{ error }}</p>
	</div>
</template>
