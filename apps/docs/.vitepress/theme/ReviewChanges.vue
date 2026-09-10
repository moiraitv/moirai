<script setup lang="ts">
import { computed } from 'vue';
import { useData } from 'vitepress';
import type { ReviewChange } from '../../../../scripts/user-docs-review';
import ReviewImage from './ReviewImage.vue';
import './review-changes.scss';

const { frontmatter } = useData();
const changes = computed(() => JSON.parse(frontmatter.value.reviewChanges ?? '[]') as ReviewChange[]);
</script>

<template>
	<div class="review-changes">
		<p v-if="changes.length">Compare the current guide with its last approved version. Images start on After; use Before and After to swap them in place. Text additions are marked + and removals −. This page does not approve changes.</p>
		<section v-for="change in changes" :id="`review-${change.id}`" :key="change.id" class="review-topic" :aria-label="change.title">
			<h2><a :href="change.href">{{ change.title }}</a></h2>
			<p><code>{{ change.id }}</code></p>
			<p v-if="change.baseline === 'initial'" class="review-baseline-note">New page — no earlier approval exists.</p>
			<p v-else-if="change.baseline === 'unavailable'" class="review-baseline-note">The approved version was not found in the last 100 guide commits available in this checkout. Current images are shown without a Before version; a verified text diff is unavailable.</p>
			<template v-if="change.textDiff.length">
				<h3>Text changes</h3>
				<pre class="review-text-diff" tabindex="0" :aria-label="`Text changes for ${change.title}`"><code><span v-for="(line, index) in change.textDiff" :key="index" :class="{ added: line.startsWith('+'), removed: line.startsWith('-'), hunk: line.startsWith('@@') }">{{ line }}{{ '\n' }}</span></code></pre>
			</template>
			<p v-else-if="change.baseline === 'approved'">No text changes.</p>
			<template v-if="change.images.length">
				<h3>Image changes</h3>
				<ReviewImage v-for="image in change.images" :key="image.name" :image="image" />
			</template>
		</section>
	</div>
</template>
