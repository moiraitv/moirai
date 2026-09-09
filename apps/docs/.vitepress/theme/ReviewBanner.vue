<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { helpReviewLabel, type HelpReviewReason } from '../../../web/src/help-review';
import { useData } from 'vitepress';

/** Review metadata for one generated guide page. */
interface ReviewPage {
	id: string;
	path: string;
	reviewReasons?: HelpReviewReason[];
	reviewStatus: 'needs-review' | 'reviewed';
}

/** Minimal manifest shape consumed by the guide theme. */
interface ReviewManifest {
	pages: ReviewPage[];
}

const { frontmatter, page } = useData();
const manifest = ref<ReviewManifest>();
const reviewLabel = computed(() => helpReviewLabel(manifest.value?.pages.find(
	(entry) => entry.id === frontmatter.value.id,
)?.reviewReasons));

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
		<strong>{{ reviewLabel }}</strong>
		<span>This guidance needs review before a production release.</span>
		<a href="/help/review.html">See review status</a>
		<dl class="review-banner-metadata">
			<div><dt>Topic ID</dt><dd><code>{{ frontmatter.id }}</code></dd></div>
			<div><dt>File</dt><dd><code>apps/docs/src/{{ page.relativePath }}</code></dd></div>
		</dl>
	</div>
</template>
