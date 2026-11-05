<script setup lang="ts">
import { Film } from '@lucide/vue';
import { ref, watch } from 'vue';
import type { GraphicsAsset } from '@moirai/shared';

const props = defineProps<{ asset: GraphicsAsset; animated: boolean }>();
const video = ref<HTMLVideoElement>();
const ready = ref(false);

watch([video, () => props.animated], ([element, animated]) => {
	if (animated) {
		void element?.play().catch(() => undefined);
	}
	else {
		element?.pause();
	}
});
</script>

<template>
	<span class="graphics-picker-thumbnail" aria-hidden="true">
		<template v-if="asset.kind === 'video'">
			<Film v-if="!ready" :size="17" />
			<video v-show="ready" ref="video" :src="`/api/v1/graphics/assets/${asset.id}#t=0.1`" preload="metadata" muted loop playsinline @loadeddata="ready = true" />
		</template>
		<img v-else :src="`/api/v1/graphics/assets/${asset.id}`" alt="" loading="lazy" />
	</span>
</template>
