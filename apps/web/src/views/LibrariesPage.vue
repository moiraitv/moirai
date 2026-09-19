<script setup lang="ts">
import LibraryCreateModal from '../components/library/LibraryCreateModal.vue';
import { onMounted, onUnmounted, ref } from 'vue';
import { storeToRefs } from 'pinia';
import { ChevronRight, FileText, Film, FolderOpen, Music2, Plus, RefreshCw, TvMinimal, Unplug } from '@lucide/vue';
import {
	type Library,
	type LibraryContentPreview,
} from '@moirai/shared';
import { api } from '../api';
import { artworkSrcset, artworkVariantUrl } from '../artwork-url';
import { errorMessage } from '../error-message';
import { hideBrokenImage } from '../image-error';
import { liveEvents } from '../live-events';
import LoadingState from '../components/LoadingState.vue';
import MediaCardPreview from '../components/MediaCardPreview.vue';
import PageHeader from '../components/PageHeader.vue';
import ResourceEmptyState from '../components/ResourceEmptyState.vue';
import StatusPill from '../components/StatusPill.vue';
import { isLibraryScanning as isScanning, isLibrarySourceUnavailable, libraryStatusValue } from '../library-health';
import { useLibrariesStore } from '../stores/libraries';

const librariesStore = useLibrariesStore();
const { libraries, loading, loaded, error: loadError } = storeToRefs(librariesStore);
const showForm = ref(false);
const contentPreviews = ref(new Map<string, LibraryContentPreview>());
const previewsLoading = ref(true);
const previewsLoaded = ref(false);
const previewsError = ref('');
let previewLoadSequence = 0;
let previewRefreshTimer: number | undefined;
/** Choose the navigation icon associated with a library type. */
function libraryIcon(typeKey: string) {
	if (typeKey === 'movies') {
		return Film;
	}

	if (typeKey === 'shows') {
		return TvMinimal;
	}

	if (typeKey === 'music-videos') {
		return Music2;
	}

	return FolderOpen;
}

/** Return the bounded recently indexed media currently loaded for one library. */
function previewItems(libraryId: string): LibraryContentPreview['items'] {
	return contentPreviews.value.get(libraryId)?.items ?? [];
}

/** Return the indexed items omitted after the bounded overview carousel. */
function remainingItemCount(library: Library): number {
	return Math.max(0, library.itemCount - previewItems(library.id).length);
}

/** Load all library carousels through one bounded overview request. */
async function loadContentPreviews(): Promise<void> {
	const sequence = ++previewLoadSequence;
	if (!previewsLoaded.value) {
		previewsLoading.value = true;
	}

	try {
		const result = await api.libraryContentPreviews();
		if (sequence !== previewLoadSequence) {
			return;
		}

		contentPreviews.value = new Map(result.map((preview) => [preview.libraryId, preview]));
		previewsLoaded.value = true;
		previewsError.value = '';
	}
	catch (cause) {
		if (sequence === previewLoadSequence) {
			previewsError.value = errorMessage(cause);
		}
	}
	finally {
		if (sequence === previewLoadSequence) {
			previewsLoading.value = false;
		}
	}
}

/** Coalesce content-preview refreshes after catalog-affecting events. */
function schedulePreviewRefresh(): void {
	window.clearTimeout(previewRefreshTimer);
	previewRefreshTimer = window.setTimeout(() => void loadContentPreviews(), 100);
}
/** Refresh the catalog after the creator has persisted a library. */
async function created(): Promise<void> {
	await librariesStore.load();
	await loadContentPreviews();
}
const unsubscribe = liveEvents.subscribe((event) => {
	if (
		event.type === 'system.ready'
		|| event.type === 'library.changed'
		|| (event.type === 'scan.changed' && event.data.status !== 'running')
	) {
		schedulePreviewRefresh();
	}
});
onMounted(() => {
	void librariesStore.load();
	void loadContentPreviews();
});
onUnmounted(() => {
	window.clearTimeout(previewRefreshTimer);
	unsubscribe();
});
</script>
<template>
	<section>
		<PageHeader
			eyebrow="Media sources"
			title="Libraries"
			description="Moirai watches each source, reconciles metadata, and keeps an index ready for scheduling."
		><button class="button" @click="showForm = true">
			<Plus :size="18" />
			Add Library
		</button></PageHeader
		>
		<LibraryCreateModal v-if="showForm" @close="showForm = false" @saved="created" />
		<p v-if="loadError" class="notice error">
			{{ loadError }}
			<button class="button ghost" @click="librariesStore.load">Retry</button>
		</p>
		<LoadingState v-if="loading && !loaded" label="Loading libraries…" />
		<div v-else-if="loaded && libraries.length" class="library-list async-state-surface">
			<article
				v-for="library in libraries"
				:key="library.id"
				class="library-row"
			>
				<RouterLink
					class="library-row-heading"
					:to="`/libraries/${library.id}`"
					:aria-label="`Open library ${library.name}`"
				>
					<div class="library-art">
						<RefreshCw v-if="isScanning(library)" class="spinning" :size="30" />
						<component :is="libraryIcon(library.typeKey)" v-else :size="30" />
					</div>
					<div class="library-row-copy">
						<div class="card-title-row">
							<h2>{{ library.name }}</h2>
							<div class="library-row-actions">
								<StatusPill :value="libraryStatusValue(library, isScanning(library))" />
								<span
									class="library-row-navigation"
									aria-hidden="true"
								>
									<ChevronRight :size="20" aria-hidden="true" />
								</span>
							</div>
						</div>
						<p>{{ library.itemCount }} indexed</p>
						<p
							v-if="isLibrarySourceUnavailable(library) && !isScanning(library)"
							class="library-source-warning"
						>
							<Unplug :size="15" />Source path unavailable; disk may be offline
						</p>
						<small>{{ library.sourceConfig.scanRoot }}</small>
					</div>
				</RouterLink>
				<div class="library-content-carousel" :aria-label="`${library.name} recently added media`">
					<div v-if="previewsLoading && !previewsLoaded" class="library-carousel-state">Loading recent media…</div>
					<div v-else-if="previewsError" class="library-carousel-state error">Unable to load recent media. <button type="button" @click="loadContentPreviews">Retry</button></div>
					<template v-else-if="previewItems(library.id).length">
						<MediaCardPreview v-for="item in previewItems(library.id)" :key="item.id" :item="item" class="library-carousel-preview">
							<RouterLink :to="`/libraries/${library.id}/items/${item.id}`" class="library-carousel-card" :class="{ unavailable: item.availability !== 'available' }">
								<span>
									<img v-if="item.artworkUrl" :src="artworkVariantUrl(item.artworkUrl, 'thumb')" :srcset="artworkSrcset(item.artworkUrl, 'thumb')" alt="" loading="lazy" decoding="async" @error="hideBrokenImage" />
									<FileText v-else :size="23" />
								</span>
								<strong>{{ item.title }}</strong>
								<small>{{ item.year ?? 'Year unknown' }}</small>
							</RouterLink>
						</MediaCardPreview>
						<RouterLink v-if="remainingItemCount(library)" :to="`/libraries/${library.id}?sort=date-added`" class="library-carousel-more">
							<span><Plus :size="25" /></span>
							<strong>{{ remainingItemCount(library).toLocaleString() }} more</strong>
							<small>{{ remainingItemCount(library) === 1 ? 'indexed item' : 'indexed items' }}</small>
						</RouterLink>
					</template>
					<div v-else class="library-carousel-state">No indexed media yet.</div>
				</div>
			</article>
		</div>
		<ResourceEmptyState
			v-else-if="loaded && !showForm"
			title="Build your first library"
			description="Choose a folder with media and Kodi-compatible NFO sidecars."
		>
			<template #icon><FolderOpen :size="37" /></template>
			<button class="button" type="button" @click="showForm = true">
				<Plus :size="18" />Add Library
			</button>
		</ResourceEmptyState>
	</section>
</template>
