<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { storeToRefs } from 'pinia';
import { Film, FolderOpen, Music2, Plus, TvMinimal, Unplug } from '@lucide/vue';
import {
	DEFAULT_FALLBACK_SCAN_INTERVAL_MINUTES,
	type Library,
	type LibraryCreate,
} from '@moirai/shared';
import { api } from '../api';
import { errorMessage } from '../error-message';
import LoadingState from '../components/LoadingState.vue';
import PageHeader from '../components/PageHeader.vue';
import StatusPill from '../components/StatusPill.vue';
import { isLibrarySourceUnavailable, libraryStatusValue } from '../library-health';
import { useLibrariesStore } from '../stores/libraries';

const librariesStore = useLibrariesStore();
const { libraries, loading, loaded, error: loadError } = storeToRefs(librariesStore);
const showForm = ref(false);
const busy = ref(false);
const error = ref('');
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
	}
	catch (cause) {
		error.value = errorMessage(cause);
	}
	finally {
		busy.value = false;
	}
}
onMounted(() => void librariesStore.load());
</script>
<template>
	<section>
		<PageHeader
			eyebrow="Media sources"
			title="Libraries"
			description="Moirai watches each source, reconciles metadata, and keeps an index ready for scheduling."
		><button class="button" @click="showForm = !showForm">
			<Plus :size="18" />
			{{ showForm ? 'Close' : 'Add library' }}
		</button></PageHeader
		>
		<form v-if="showForm" class="panel form-grid" @submit.prevent="create">
			<label
			><span>Name</span><input v-model="form.name" required placeholder="Cinema archive"
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
			<label class="span-2"
			><span>Path Moirai scans</span
			><input v-model="form.sourceConfig.scanRoot" required placeholder="/media/movies"
			/></label>
			<label class="span-2"
			><span>Path playback engine sees <small>optional</small></span
			><input v-model="form.sourceConfig.playbackRoot" placeholder="/media/movies"
			/></label>
			<label
			><span>Fallback scan, minutes</span
			><input v-model.number="form.scanIntervalMinutes" type="number" min="1" max="10080"
			/><small>Used when live watching is unavailable; healthy watchers receive a daily integrity scan.</small></label>
			<label class="check"
			><input v-model="form.watcherEnabled" type="checkbox" /> Watch for changes</label
			>
			<p v-if="error" class="notice error span-2">{{ error }}</p>
			<div class="form-actions span-2">
				<button class="button" :disabled="busy">{{ busy ? 'Adding…' : 'Add and scan' }}</button>
			</div>
		</form>
		<p v-if="loadError" class="notice error">
			{{ loadError }}
			<button class="button ghost" @click="librariesStore.load">Retry</button>
		</p>
		<LoadingState v-if="loading && !loaded" label="Loading libraries…" />
		<div v-else-if="loaded && libraries.length" class="library-grid">
			<RouterLink
				v-for="library in libraries"
				:key="library.id"
				:to="`/libraries/${library.id}`"
				class="library-card"
			>
				<div class="library-art"><component :is="libraryIcon(library.typeKey)" :size="34" /></div>
				<div>
					<div class="card-title-row">
						<h2>{{ library.name }}</h2>
						<StatusPill :value="libraryStatusValue(library, isScanning(library))" />
					</div>
					<p>{{ library.itemCount }} indexed · {{ library.warningCount }} warnings</p>
					<p
						v-if="isLibrarySourceUnavailable(library) && !isScanning(library)"
						class="library-source-warning"
					>
						<Unplug :size="15" />Source path unavailable; disk may be offline
					</p>
					<small>{{ library.sourceConfig.scanRoot }}</small>
				</div>
			</RouterLink>
		</div>
		<div v-else-if="loaded && !showForm" class="empty-state">
			<span>◇</span>
			<h3>Build your first library</h3>
			<p>Choose a folder with media and Kodi-compatible NFO sidecars.</p>
		</div>
	</section>
</template>
