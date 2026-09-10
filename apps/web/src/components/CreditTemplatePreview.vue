<script setup lang="ts">
import { useDisclosureState } from '../disclosure-state';
import { onMounted, ref, watch } from 'vue';
import type { Channel, CreditPreviewResult, Library, MediaItem } from '@moirai/shared';
import { api } from '../api';
import { errorMessage } from '../error-message';
import LoadingState from './LoadingState.vue';

const sourceOpen = useDisclosureState('credit-preview-source');

const props = defineProps<{ source: string }>();
const emit = defineEmits<{ busy: [value: boolean] }>();
const libraries = ref<Library[]>([]);
const channels = ref<Channel[]>([]);
const items = ref<MediaItem[]>([]);
const libraryId = ref('');
const channelId = ref('');
const itemId = ref('');
const search = ref('');
const seconds = ref(10);
const loaded = ref(false);
const itemsLoaded = ref(false);
const searching = ref(false);
const rendering = ref(false);
const error = ref('');
const preview = ref<CreditPreviewResult>();
const page = ref(1);
const totalPages = ref(1);
let sequence = 0;
let previewSequence = 0;

/** Load channel and music-library options with an explicit initial loading state. */
async function load(): Promise<void> {
	try {
		const [libraryRows, channelRows] = await Promise.all([api.libraries(), api.channels()]);
		libraries.value = libraryRows.filter((library) => library.typeKey === 'music-videos');
		channels.value = channelRows;
		libraryId.value = libraries.value[0]?.id ?? '';
		channelId.value = channels.value[0]?.id ?? '';
		loaded.value = true;
	}
	catch (cause) {
		error.value = errorMessage(cause);
	}
}

/** Search all music-video items without requiring navigation through artist groups. */
async function findItems(): Promise<void> {
	const token = ++sequence;
	itemsLoaded.value = false;
	itemId.value = '';
	if (!libraryId.value) {
		return;
	}
	searching.value = true;
	try {
		const result = await api.mediaSourceOptions(libraryId.value, { target: 'items', page: page.value, pageSize: 20, search: search.value });
		if (token !== sequence) {
			return;
		}
		items.value = result.entries.flatMap((entry) => entry.item ? [entry.item] : []);
		totalPages.value = result.pagination.totalPages;
		itemsLoaded.value = true;
		itemId.value = items.value[0]?.id ?? '';
	}
	catch (cause) {
		error.value = errorMessage(cause);
	}
	finally {
		if (token === sequence) {
			searching.value = false;
		}
	}
}

/** Render the current draft and retain errors beside the preview controls. */
async function render(): Promise<void> {
	const token = ++previewSequence;
	rendering.value = true;
	emit('busy', true);
	error.value = '';
	preview.value = undefined;
	try {
		const result = await api.previewCreditTemplate({ source: props.source, channelId: channelId.value, mediaItemId: itemId.value, seconds: seconds.value });
		if (token === previewSequence) {
			preview.value = result;
		}
	}
	catch (cause) {
		error.value = errorMessage(cause);
	}
	finally {
		rendering.value = false;
		emit('busy', false);
	}
}
watch([libraryId, page], ([currentLibrary], [previousLibrary]) => {
	if (currentLibrary !== previousLibrary && page.value !== 1) {
		page.value = 1;
		return;
	}
	void findItems();
});
watch([() => props.source, channelId, itemId, seconds], () => {
	previewSequence++;
	preview.value = undefined; 
});
onMounted(load);
</script>

<template>
	<section class="credit-preview">
		<h3>Preview on a music video</h3>
		<LoadingState v-if="!loaded && !error" />
		<template v-if="loaded">
			<p v-if="!libraries.length || !channels.length">Create a music-video library and channel to preview credits.</p>
			<div v-else class="form-grid three">
				<label><span>Library</span><select v-model="libraryId"><option v-for="library in libraries" :key="library.id" :value="library.id">{{ library.name }}</option></select></label>
				<label><span>Channel resolution and fonts</span><select v-model="channelId"><option v-for="channel in channels" :key="channel.id" :value="channel.id">{{ channel.name }}</option></select></label>
				<label><span>Find video</span><input v-model="search" type="search" @keydown.enter.prevent="page = 1; findItems()" /></label>
				<button class="button secondary" type="button" :disabled="searching" @click="page = 1; findItems()">Search</button>
				<label><span>Music video</span><select v-model="itemId" :disabled="!itemsLoaded"><option v-for="item in items" :key="item.id" :value="item.id">{{ item.title }}</option></select></label>
				<label><span>Source time (seconds)</span><input v-model.number="seconds" type="number" min="0" step="0.1" /></label>
			</div>
			<LoadingState v-if="searching" label="Loading music videos…" />
			<p v-else-if="itemsLoaded && !items.length">No matching music videos.</p>
			<div v-if="itemsLoaded && totalPages > 1" class="form-actions"><button type="button" class="button secondary" :disabled="page <= 1" @click="page--">Previous</button><span>{{ page }} / {{ totalPages }}</span><button type="button" class="button secondary" :disabled="page >= totalPages" @click="page++">Next</button></div>
			<button class="button secondary" type="button" :disabled="rendering || !itemId || !channelId" @click="render">{{ rendering ? 'Rendering…' : 'Render preview' }}</button>
		</template>
		<p v-if="error" class="notice error">{{ error }}</p>
		<template v-if="preview"><img :src="preview.image" alt="Music-video frame with the generated credits" /><details :open="sourceOpen" @toggle="sourceOpen = ($event.target as HTMLDetailsElement).open"><summary>Generated subtitles (.ass)</summary><pre>{{ preview.ass }}</pre></details></template>
	</section>
</template>
