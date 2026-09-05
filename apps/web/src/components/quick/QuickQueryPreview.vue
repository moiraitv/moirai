<script setup lang="ts">
import { Asterisk } from '@lucide/vue';
import type { QuickChannelQueryPreviewResult } from '@moirai/shared/api-contracts';
import { useVirtualizer } from '@tanstack/vue-virtual';
import { computed, nextTick, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';
import { artworkSrcset, artworkVariantUrl } from '../../artwork-url';
import { hideBrokenImage } from '../../image-error';
import MediaCardPreview from '../MediaCardPreview.vue';

const props = withDefaults(defineProps<{
	heading?: string;
	label?: string;
	items: QuickChannelQueryPreviewResult['items'];
	indexedItemCount: number;
	loading: boolean;
	loadingMore: boolean;
	loaded: boolean;
	hasMore: boolean;
	error: string;
}>(), { heading: 'Matching now', label: 'Currently matching media' });
const emit = defineEmits<{ retry: []; loadMore: [] }>();
const scrollElement = ref<HTMLElement | null>(null);
/** Fixed card width used by the horizontal virtualizer and matching carousel styles. */
const queryPreviewCardWidth = 112;
const virtualizer = useVirtualizer<HTMLElement, HTMLElement>(computed(() => ({
	count: props.items.length,
	getScrollElement: () => scrollElement.value,
	estimateSize: () => queryPreviewCardWidth,
	horizontal: true,
	gap: 0,
	overscan: 4,
	getItemKey: (index: number) => props.items[index]?.id ?? index,
})));
const virtualItems = computed(() => virtualizer.value.getVirtualItems());
const totalWidth = computed(() => virtualizer.value.getTotalSize());

watch(virtualItems, (visibleItems) => {
	const last = visibleItems.at(-1);
	if (last && last.index >= props.items.length - 6 && props.hasMore && !props.loadingMore) {
		emit('loadMore');
	}
});
watch(() => props.items.length, async () => {
	await nextTick();
	virtualizer.value.measure();
});
</script>

<template>
	<section class="quick-query-preview" :aria-label="label">
		<div class="quick-query-preview-heading" aria-live="polite">
			<strong>{{ heading }}</strong>
			<small v-if="loaded && !error">
				{{ indexedItemCount.toLocaleString() }} indexed<span v-if="loadingMore"> · Loading more…</span>
			</small>
			<small v-else aria-hidden="true">&nbsp;</small>
		</div>
		<p v-if="loading && !loaded" class="quick-query-preview-state">Loading matching media…</p>
		<p v-else-if="error && !items.length" class="quick-query-preview-state error">
			Unable to load matching media. <button type="button" @click="emit('retry')">Retry</button>
		</p>
		<div
			v-else-if="items.length"
			ref="scrollElement"
			class="quick-query-carousel"
			tabindex="0"
			:aria-label="label === 'Currently matching media' ? 'Matching media carousel' : `${label} carousel`"
		>
			<div
				class="program-carousel quick-query-carousel-track"
				:style="{ width: `${totalWidth}px` }"
			>
				<MediaCardPreview
					v-for="virtualItem in virtualItems"
					:key="String(virtualItem.key)"
					:item="items[virtualItem.index]!"
					class="program-carousel-preview quick-query-carousel-item"
					:style="{ transform: `translateX(${virtualItem.start}px)` }"
				>
					<RouterLink
						:to="`/libraries/${items[virtualItem.index]!.libraryId}/items/${items[virtualItem.index]!.id}`"
						class="program-carousel-card"
						:class="{ unavailable: items[virtualItem.index]!.availability !== 'available' }"
					>
						<span>
							<img
								v-if="items[virtualItem.index]!.artworkUrl"
								:src="artworkVariantUrl(items[virtualItem.index]!.artworkUrl!, 'thumb')"
								:srcset="artworkSrcset(items[virtualItem.index]!.artworkUrl!, 'thumb')"
								alt=""
								loading="lazy"
								@error="hideBrokenImage"
							/>
							<Asterisk v-else :size="23" />
						</span>
						<strong>{{ items[virtualItem.index]!.title }}</strong>
						<small>{{ items[virtualItem.index]!.year ?? 'Year unknown' }}</small>
						<em v-if="items[virtualItem.index]!.availability !== 'available'">Unavailable</em>
					</RouterLink>
				</MediaCardPreview>
			</div>
		</div>
		<p v-else-if="loaded" class="quick-query-preview-state">No indexed media matches yet.</p>
		<p v-if="error && items.length" class="quick-query-preview-state error">
			Unable to load more matching media. <button type="button" @click="emit('retry')">Retry</button>
		</p>
	</section>
</template>
