<script setup lang="ts">
import { ArrowLeft, Asterisk, ChevronDown, Layers3, Plus, X } from '@lucide/vue';
import type { ContentSource, MediaGroup, MediaItem, MediaSourcePickerEntry } from '@moirai/shared';
import { mediaSearchMatchText } from '../../media-search-matches';
import LoadingState from '../LoadingState.vue';
import { artworkSrcset, artworkVariantUrl } from '../../artwork-url';
import { hideBrokenImage } from '../../image-error';
import { mediaGroupSubtitle, mediaItemSubtitle } from '../../media-labels';

const open = defineModel<boolean>('open', { required: true });
const search = defineModel<string>('search', { required: true });
const props = defineProps<{
	sourceType: ContentSource['type'];
	libraryType: string;
	sourceEntries: MediaSourcePickerEntry[];
	sourceLoading: boolean;
	sourceLoaded: boolean;
	sourceParentId: string | undefined;
	sourcePage: number;
	sourceTotalPages: number;
	selectedIdSet: ReadonlySet<string>;
	selectedGroupIdSet: ReadonlySet<string>;
}>();
const emit = defineEmits<{
	search: [];
	root: [];
	browse: [entry: MediaSourcePickerEntry];
	select: [entry: MediaSourcePickerEntry];
	toggleItem: [item: MediaItem];
	toggleGroup: [group: MediaGroup];
	page: [page: number];
}>();

/** Build the compact metadata line shown for a source result. */
function sourceEntrySubtitle(entry: MediaSourcePickerEntry): string {
	if (entry.group) {
		return mediaGroupSubtitle(props.libraryType, entry.group) || entry.group.kind;
	}

	if (entry.item) {
		return mediaItemSubtitle(props.libraryType, entry.item) || entry.item.kind;
	}

	return '';
}


</script>

<template>
	<details
		class="source-browser-disclosure"
		:open="open"
		@toggle="open = ($event.target as HTMLDetailsElement).open"
	>
		<summary>Browse media <ChevronDown :size="17" /></summary>
		<div class="source-picker-toolbar">
			<input
				v-model="search"
				type="search"
				aria-label="Search source media"
				:placeholder="libraryType === 'music-videos' ? 'Search title, plot, artist, album, genre…' : 'Search title, plot, genre, actor, director…'"
				@keydown.enter.prevent="emit('search')"
			/>
			<button type="button" class="toolbar-button" @click="emit('search')">
				Search
			</button>
		</div>
		<button
			v-if="sourceParentId"
			type="button"
			class="button secondary source-browser-back"
			@click="emit('root')"
		>
			<ArrowLeft :size="18" aria-hidden="true" />Back to Library Root
		</button>
		<LoadingState v-if="sourceLoading" label="Loading source media…" />
		<div v-else-if="sourceEntries.length" class="source-picker-list">
			<article v-for="entry in sourceEntries" :key="entry.key">
				<span class="source-picker-artwork">
					<span class="source-artwork-placeholder">
						<Layers3 v-if="entry.group" :size="20" />
						<Asterisk v-else :size="20" />
					</span>
					<img
						v-if="entry.group?.artworkUrl || entry.item?.artworkUrl"
						:src="
							artworkVariantUrl(
								entry.group?.artworkUrl ?? entry.item?.artworkUrl,
								'thumb',
							)
						"
						:srcset="
							artworkSrcset(
								entry.group?.artworkUrl ?? entry.item?.artworkUrl,
								'thumb',
							)
						"
						:alt="`${entry.group?.title ?? entry.item?.title} artwork`"
						loading="eager"
						decoding="async"
						@error="hideBrokenImage"
					/>
				</span>
				<span class="source-picker-copy">
					<strong>{{ entry.group?.title ?? entry.item?.title }}</strong>
					<small>{{ sourceEntrySubtitle(entry) }}</small>
					<small v-if="mediaSearchMatchText(entry.matches)" class="source-match-context" :title="`Matched ${mediaSearchMatchText(entry.matches)}`">
						Matched {{ mediaSearchMatchText(entry.matches) }}
					</small>
				</span>
				<div class="source-picker-actions">
					<button
						v-if="entry.group && entry.group.childCount > 0"
						type="button"
						class="button secondary contextual"
						@click="emit('browse', entry)"
					>
						Browse</button
					><button
						v-if="
							(sourceType === 'group' && entry.group) ||
								(sourceType === 'item' && entry.item)
						"
						type="button"
						class="text-button"
						@click="emit('select', entry)"
					>
						Select
					</button>
					<button
						v-if="sourceType === 'collection' && entry.item"
						type="button"
						class="source-selection-button"
						:class="{ selected: selectedIdSet.has(entry.item.id) }"
						@click="emit('toggleItem', entry.item)"
					>
						<X v-if="selectedIdSet.has(entry.item.id)" :size="14" />
						<Plus v-else :size="14" />
						{{ selectedIdSet.has(entry.item.id) ? 'Remove' : 'Add' }}
					</button>
					<button
						v-if="sourceType === 'group-collection' && entry.group"
						type="button"
						class="source-selection-button"
						:class="{ selected: selectedGroupIdSet.has(entry.group.id) }"
						@click="emit('toggleGroup', entry.group)"
					>
						<X v-if="selectedGroupIdSet.has(entry.group.id)" :size="14" />
						<Plus v-else :size="14" />
						{{ selectedGroupIdSet.has(entry.group.id) ? 'Remove' : 'Add' }}
					</button>
				</div>
			</article>
		</div>
		<div v-else-if="sourceLoaded" class="empty-state compact">
			<p>No matching source media.</p>
		</div>
		<div v-if="sourceTotalPages > 1" class="source-picker-pagination">
			<button
				type="button"
				class="toolbar-button"
				:disabled="sourcePage <= 1"
				@click="emit('page', sourcePage - 1)"
			>
				Previous
			</button>
			<small>Page {{ sourcePage }} of {{ sourceTotalPages }}</small>
			<button
				type="button"
				class="toolbar-button"
				:disabled="sourcePage >= sourceTotalPages"
				@click="emit('page', sourcePage + 1)"
			>
				Next
			</button>
		</div>
	</details>
</template>
