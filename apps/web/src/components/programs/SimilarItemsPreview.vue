<script setup lang="ts">
import { computed } from 'vue';
import LoadingState from '../LoadingState.vue';
import { FileText } from '@lucide/vue';
import type { SchedulingProgramPreviewItem } from '@moirai/shared';
import MediaCardPreview from '../MediaCardPreview.vue';
import { artworkSrcset, artworkVariantUrl } from '../../artwork-url';
import { hideBrokenImage } from '../../image-error';

const props = withDefaults(defineProps<{ items: SchedulingProgramPreviewItem[]; matchingCount?: number | undefined; requestedCount?: number | undefined; loading?: boolean; message?: string | undefined; error?: boolean; heading?: string; emptyMessage?: string | undefined; presentation?: 'catalog' | 'editor' }>(), {
	emptyMessage: 'No related items match these settings.',
	presentation: 'catalog',
	heading: 'Sample matches',
	message: undefined,
	matchingCount: undefined,
	requestedCount: undefined,
});
const overlay = computed(() => props.loading || props.error || !props.items.length);
const shortage = computed(() => !props.loading && !props.error && props.matchingCount !== undefined && props.requestedCount !== undefined && props.matchingCount < props.requestedCount
	? `${props.matchingCount} related matches available; requested ${props.requestedCount}.` : '');
const overlayMessage = computed(() => [shortage.value, props.message || (props.loading ? 'Finding sample matches…' : props.emptyMessage)].filter(Boolean).join(' '));
</script>

<template>
	<section class="similarity-sample" :class="`similarity-sample--${presentation}`" :aria-label="heading">
		<p class="similarity-sample-heading" :class="{ eyebrow: presentation === 'catalog' }">{{ heading }}</p>
		<div class="similarity-sample-stage" :aria-busy="loading">
			<div class="program-carousel" :class="{ 'similarity-sample-dimmed': overlay }" :inert="overlay" :aria-hidden="overlay ? true : undefined">
				<template v-if="items.length">
					<MediaCardPreview v-for="item in items" :key="item.id" :item="item" class="program-carousel-preview">
						<RouterLink :to="`/libraries/${item.libraryId}/items/${item.id}`" class="program-carousel-card">
							<span><img v-if="item.artworkUrl" :src="artworkVariantUrl(item.artworkUrl, 'thumb')" :srcset="artworkSrcset(item.artworkUrl, 'thumb')" alt="" loading="lazy" @error="hideBrokenImage" /><FileText v-else :size="23" /></span>
							<strong>{{ item.title }}</strong><small>{{ item.year ?? 'Year unknown' }}</small>
						</RouterLink>
					</MediaCardPreview>
				</template>
				<template v-else>
					<article v-for="index in 5" :key="index" class="similarity-sample-placeholder" aria-hidden="true"><span></span><strong></strong><small></small></article>
				</template>
			</div>
			<div v-if="overlay" class="similarity-sample-overlay">
				<LoadingState v-if="loading" :label="overlayMessage" />
				<p v-else :role="error ? 'alert' : 'status'">{{ overlayMessage }}</p>
			</div>
		</div>
		<p v-if="!overlay && (message || shortage)" class="notice">{{ [shortage, message].filter(Boolean).join(' ') }}</p>
	</section>
</template>
