<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useData } from 'vitepress';

/** Review metadata for one generated guide page. */
interface ReviewPage {
	id: string;
	path: string;
	reviewStatus: 'needs-review' | 'reviewed';
}

/** Minimal manifest shape consumed by the guide theme. */
interface ReviewManifest {
	pages: ReviewPage[];
}

const { frontmatter } = useData();
const manifest = ref<ReviewManifest>();

/** Load review state emitted from the same Markdown used by the guide. */
async function loadReviewState(): Promise<void> {
	const response = await fetch('/help/contextual-help.json');
	if (response.ok) {
		manifest.value = await response.json() as ReviewManifest;
	}
}

const needsReview = computed(() => {
	const id = frontmatter.value.id as string | undefined;
	return Boolean(id && manifest.value?.pages.find((page) => page.id === id)?.reviewStatus !== 'reviewed');
});

onMounted(() => void loadReviewState());
watch(() => frontmatter.value.id, () => void loadReviewState());
</script>

<template>
	<div v-if="needsReview" class="review-banner" role="status">
		<strong>Needs review</strong>
		<span>This first-pass guidance has not yet been approved for a production release.</span>
		<a href="/help/review.html">See review status</a>
	</div>
</template>
