<script setup lang="ts">
import { onMounted, onUnmounted, reactive, ref } from 'vue';
import { storeToRefs } from 'pinia';
import { FileText, Film, FolderOpen, Music2, Plus, RefreshCw, TvMinimal, Unplug } from '@lucide/vue';
import {
	DEFAULT_FALLBACK_SCAN_INTERVAL_MINUTES,
	type Library,
	type LibraryContentPreview,
	type LibraryCreate,
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
import { isLibrarySourceUnavailable, libraryStatusValue } from '../library-health';
import { useLibrariesStore } from '../stores/libraries';

const librariesStore = useLibrariesStore();
const { libraries, loading, loaded, error: loadError } = storeToRefs(librariesStore);
const showForm = ref(false);
const busy = ref(false);
const error = ref('');
const contentPreviews = ref(new Map<string, LibraryContentPreview>());
const previewsLoading = ref(true);
const previewsLoaded = ref(false);
const previewsError = ref('');
let previewLoadSequence = 0;
let previewRefreshTimer: number | undefined;
const form = reactive<LibraryCreate>({
	name: '',
	typeKey: 'movies',
	sourceType: 'on-disk',
	sourceConfig: { scanRoot: '', playbackRoot: null },
	scanIntervalMinutes: DEFAULT_FALLBACK_SCAN_INTERVAL_MINUTES,
	watcherEnabled: true,
	enabled: true,
});
/** Return whether the library has a scan that has not completed. */
function isScanning(library: Library): boolean {
	return Boolean(
		library.lastScanStartedAt
		&& (!library.lastScanCompletedAt || library.lastScanStartedAt > library.lastScanCompletedAt),
	);
}
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
/** Create a library from the form and refresh the list. */
async function create() {
	busy.value = true;
	error.value = '';
	try {
		await api.createLibrary({
			...form,
			sourceConfig: { ...form.sourceConfig, playbackRoot: form.sourceConfig.playbackRoot || null },
		});
		showForm.value = false;
		form.name = '';
		form.sourceConfig.scanRoot = '';
		await librariesStore.load();
		await loadContentPreviews();
	}
	catch (cause) {
		error.value = errorMessage(cause);
	}
	finally {
		busy.value = false;
	}
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
		><button class="button" @click="showForm = !showForm">
			<Plus :size="18" />
			{{ showForm ? 'Close' : 'Add Library' }}
		</button></PageHeader
		>
		<Transition name="moirai-collapse">
			<form v-if="showForm" class="panel form-grid" @submit.prevent="create">
				<label
				><span>Name</span><input v-model="form.name" required autocapitalize="words" placeholder="Cinema archive"
				/></label>
				<label
				><span>Type</span
				><select v-model="form.typeKey">
					<option value="movies">Movies</option>
					<option value="shows">Shows</option>
					<option value="music-videos">Music videos</option>
					<option value="other">Other</option>
				</select></label
				>
				<div class="library-source-row span-2">
					<label
					><span>Path Moirai scans</span
					><input v-model="form.sourceConfig.scanRoot" required placeholder="/media/movies"
					/></label>
					<label class="check"
					><input v-model="form.watcherEnabled" type="checkbox" /> Watch for changes</label
					>
				</div>
				<label class="span-2"
				><span>Path playback engine sees <small>optional</small></span
				><input v-model="form.sourceConfig.playbackRoot" placeholder="/media/movies"
				/></label>
				<label class="span-2"
				><span>Fallback scan, minutes</span
				><input v-model.number="form.scanIntervalMinutes" type="number" min="1" max="10080"
				/><small>Used when live watching is unavailable; healthy watchers receive a daily integrity scan.</small></label>
				<p v-if="error" class="notice error span-2">{{ error }}</p>
				<div class="form-actions span-2">
					<button class="button" :disabled="busy">{{ busy ? 'Adding…' : 'Add and Scan' }}</button>
				</div>
			</form>
		</Transition>
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
				<div class="library-row-heading">
					<div class="library-art">
						<RefreshCw v-if="isScanning(library)" class="spinning" :size="30" />
						<component :is="libraryIcon(library.typeKey)" v-else :size="30" />
					</div>
					<div class="library-row-copy">
						<div class="card-title-row">
							<h2><RouterLink :to="`/libraries/${library.id}`">{{ library.name }}</RouterLink></h2>
							<StatusPill :value="libraryStatusValue(library, isScanning(library))" />
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
				</div>
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
							<small>indexed items</small>
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
