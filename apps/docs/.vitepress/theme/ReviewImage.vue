<script setup lang="ts">
import { ref } from 'vue';
import type { ReviewImageChange } from '../../../../scripts/user-docs-review';

const props = defineProps<{ image: ReviewImageChange }>();
const version = ref<'before' | 'after'>('after');
</script>

<template>
	<fieldset class="review-image">
		<legend>{{ props.image.name }}</legend>
		<div class="review-image-controls" role="group" :aria-label="`Compare ${props.image.name}`">
			<button type="button" :aria-pressed="version === 'before'" :disabled="!props.image.before" @click="version = 'before'">Before</button>
			<button type="button" :aria-pressed="version === 'after'" @click="version = 'after'">After</button>
			<a v-if="props.image[version]" :href="props.image[version]!" target="_blank" rel="noopener">Open full size</a>
		</div>
		<div class="review-image-stage" :style="{ aspectRatio: props.image.aspectRatio ?? undefined }">
			<img v-if="props.image.before" :src="props.image.before" :alt="`Before: ${props.image.name}`" :class="{ 'is-hidden': version !== 'before' }" :aria-hidden="version !== 'before'" loading="lazy" />
			<img v-if="props.image.after" :src="props.image.after" :alt="`After: ${props.image.name}`" :class="{ 'is-hidden': version !== 'after' }" :aria-hidden="version !== 'after'" loading="lazy" />
			<p v-else :class="{ 'is-hidden': version !== 'after' }">This image was removed from the page.</p>
		</div>
	</fieldset>
</template>
