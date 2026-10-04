<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { MAX_SUBTITLE_PREVIEW_ANCESTORS, subtitleSelectionPreviewSchema, type Channel, type Library, type MediaItem, type MediaSourcePickerEntry, type SchedulingProgram, type SubtitlePreferences, type SubtitleSelectionPreviewResult } from '@moirai/shared';
import { ChevronDown, Film } from '@lucide/vue';
import { artworkSrcset, artworkVariantUrl } from '../artwork-url';
import { hideBrokenImage } from '../image-error';
import { mediaSearchMatchText } from '../media-search-matches';
import FormDisclosure from './FormDisclosure.vue';
import { api } from '../api';
import { errorMessage } from '../error-message';
import { SUBTITLE_PREVIEW_UPDATE_DELAY_MS, subtitlePreviewParents, validSubtitlePreviewChain } from '../subtitle-preview-context';
import LoadingState from './LoadingState.vue';
import SubtitleSelectionPreviewResultView from './SubtitleSelectionPreviewResult.vue';

const props = defineProps<{ preferences?: SubtitlePreferences | undefined; inherit?: boolean; invalid: boolean; programId?: string | null | undefined }>();
const open = ref(false);
const loaded = ref(false);
const loading = ref(false);
const error = ref('');
const libraries = ref<Library[]>([]);
const channels = ref<Channel[]>([]);
const programs = ref<SchedulingProgram[]>([]);
const libraryId = ref('');
const channelId = ref('');
const chain = ref<string[]>([]);
const search = ref('');
/** Retain search context alongside each indexed video shown in the carousel. */
type SubtitlePreviewVideo = MediaItem & Pick<MediaSourcePickerEntry, 'matches'>;
const items = ref<SubtitlePreviewVideo[]>([]);
const itemsLoaded = ref(false);
const itemsLoading = ref(false);
const itemsError = ref('');
const mediaId = ref('');
const checking = ref(false);
const refreshPending = ref(false);
const checkError = ref('');
const result = ref<SubtitleSelectionPreviewResult>();
const checkedSnapshot = ref('');
const channel = computed(() => channels.value.find(value => value.id === channelId.value));
const parents = computed(() => subtitlePreviewParents(programs.value, props.programId, chain.value));
const contextValid = computed(() => !props.inherit || Boolean(channel.value && validSubtitlePreviewChain(programs.value, props.programId, chain.value)));
const request = computed(() => ({
	mediaItemId: mediaId.value,
	channelPreferences: props.inherit ? channel.value?.subtitlePreferences ?? {} : props.preferences ?? {},
	programPreferences: props.inherit ? [...chain.value.map(id => programs.value.find(program => program.id === id)?.config.subtitlePreferences ?? {}), props.preferences ?? {}] : [],
}));
const snapshot = computed(() => JSON.stringify(request.value));
const stale = computed(() => Boolean(result.value && (props.invalid || checkedSnapshot.value !== snapshot.value)));
const canCheck = computed(() => loaded.value && !props.invalid && contextValid.value && subtitleSelectionPreviewSchema.safeParse(request.value).success);
/** Maximum number of indexed search results shown in the subtitle preview carousel. */
const PREVIEW_VIDEO_LIMIT = 12;
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
let searchTimer: ReturnType<typeof setTimeout> | undefined;
let browseSequence = 0;
let checkSequence = 0;
let controller: AbortController | undefined;
onBeforeUnmount(() => {
	clearTimeout(searchTimer);
	clearTimeout(refreshTimer);
	browseSequence++;
	checkSequence++;
	controller?.abort();
});
watch([snapshot, canCheck, open], ([currentSnapshot, valid], [previousSnapshot, previouslyValid]) => {
	clearTimeout(refreshTimer);
	refreshPending.value = false;
	checkSequence++;
	controller?.abort();
	checking.value = false;
	if (currentSnapshot !== previousSnapshot || valid !== previouslyValid) {
		checkError.value = '';
	}

	if (open.value && canCheck.value && (!result.value || stale.value)) {
		refreshPending.value = true;
		refreshTimer = setTimeout(() => void check(), SUBTITLE_PREVIEW_UPDATE_DELAY_MS);
	}
});
watch(open, expanded => {
	if (expanded && !loaded.value && !loading.value) {
		void load();
	}
});
watch(libraryId, () => search.value = '');
watch([libraryId, search], () => {
	clearTimeout(searchTimer);
	browseSequence++;
	mediaId.value = '';
	items.value = [];
	itemsLoaded.value = false;
	itemsError.value = '';
	itemsLoading.value = Boolean(libraryId.value && search.value.trim());
	if (itemsLoading.value) {
		searchTimer = setTimeout(() => void browse(), SUBTITLE_PREVIEW_UPDATE_DELAY_MS);
	}
});
watch(() => props.programId, () => chain.value = []);

/** Load only the collections needed by the opened preview, retaining explicit failure states. */
async function load(): Promise<void> {
	loading.value = true;
	error.value = '';
	try {
		const results = await Promise.all([api.libraries(), props.inherit ? api.channels() : Promise.resolve([]), props.inherit ? api.schedulingOverview() : Promise.resolve(null)]);
		libraries.value = results[0];
		channels.value = results[1];
		programs.value = results[2]?.programs ?? [];
		loaded.value = true;
	}
	catch (cause) {
		error.value = errorMessage(cause);
	}
	finally {
		loading.value = false;
	}
}

/** Search one bounded page of indexed videos without probing files. */
async function browse(): Promise<void> {
	const sequence = ++browseSequence;
	mediaId.value = '';
	items.value = [];
	itemsLoaded.value = false;
	itemsError.value = '';
	if (!libraryId.value || !search.value.trim()) {
		itemsLoading.value = false;
		return;
	}
	itemsLoading.value = true;
	try {
		const response = await api.mediaSourceOptions(libraryId.value, { target: 'items', page: 1, pageSize: PREVIEW_VIDEO_LIMIT, search: search.value.trim() });
		if (sequence === browseSequence) {
			items.value = response.entries.flatMap(entry => entry.item ? [{ ...entry.item, matches: entry.matches }] : []).slice(0, PREVIEW_VIDEO_LIMIT);
			itemsLoaded.value = true;
		}
	}
	catch (cause) {
		if (sequence === browseSequence) {
			itemsError.value = errorMessage(cause);
		}
	}
	finally {
		if (sequence === browseSequence) {
			itemsLoading.value = false;
		}
	}
}

/** Add one validated containing sequence, keeping snapshots in outer-to-inner order. */
function addParent(event: Event): void {
	const id = (event.target as HTMLSelectElement).value;
	if (chain.value.length < MAX_SUBTITLE_PREVIEW_ANCESTORS && parents.value.some(program => program.id === id)) {
		chain.value.unshift(id);
	}
	(event.target as HTMLSelectElement).value = '';
}

/** Select a video and let draft-change watchers settle before checking its metadata. */
async function selectVideo(id: string): Promise<void> {
	mediaId.value = id;
	await nextTick();
	await check();
}

/** Check an immutable request snapshot and ignore responses superseded by draft changes. */
async function check(): Promise<void> {
	clearTimeout(refreshTimer);
	refreshPending.value = false;
	if (!canCheck.value) {
		return;
	}
	const sequence = ++checkSequence;
	const captured = snapshot.value;
	controller?.abort();
	controller = new AbortController();
	checking.value = true;
	checkError.value = '';
	try {
		const response = await api.previewSubtitleSelection(JSON.parse(captured), controller.signal);
		if (sequence === checkSequence) {
			result.value = response;
			checkedSnapshot.value = captured;
		}
	}
	catch (cause) {
		if (sequence === checkSequence) {
			checkError.value = errorMessage(cause);
		}
	}
	finally {
		if (sequence === checkSequence) {
			checking.value = false;
		}
	}
}
</script>

<template>
	<section class="subtitle-selection-preview" aria-label="Check subtitle selection">
		<FormDisclosure v-model:open="open">
			<template #summary>
				<span class="form-disclosure-icon" aria-hidden="true"><Film :size="26" /></span>
				<span class="form-disclosure-copy"><strong>Check against media</strong><small>Preview subtitle selection on a video</small></span>
				<ChevronDown class="form-disclosure-chevron" :size="22" aria-hidden="true" />
			</template>
			<div class="subtitle-preview-controls">
				<p>Uses scanned metadata. Subtitle contents and rendering are not checked. Chosen media need not belong to this program or its channel’s schedule.</p>
				<LoadingState v-if="loading" label="Loading preview choices…" />
				<p v-if="error" class="notice error">{{ error }} <button type="button" class="button secondary contextual" @click="load">Retry preview choices</button></p>
				<template v-if="loaded">
					<template v-if="inherit">
						<label><span>Preview channel</span><select v-model="channelId"><option value="">Choose a channel</option><option v-for="option in channels" :key="option.id" :value="option.id">{{ option.number }} · {{ option.name }}</option></select></label>
						<p v-if="!channels.length">Create a channel to provide an inheritance context.</p>
						<p class="subtitle-preview-context">Test context: {{ channel?.name || 'Choose a channel' }} → {{ chain.length ? chain.map(id => programs.find(program => program.id === id)?.name || 'Unavailable program').join(' → ') + ' → ' : '' }}Current program draft{{ !chain.length ? ' (directly on channel)' : '' }}</p>
						<label v-if="parents.length && chain.length < MAX_SUBTITLE_PREVIEW_ANCESTORS"><span>Add enclosing sequence</span><select value="" @change="addParent"><option value="">Choose a containing sequence</option><option v-for="program in parents" :key="program.id" :value="program.id">{{ program.name }}</option></select></label>
						<button v-if="chain.length" type="button" class="button secondary contextual" @click="chain.shift()">Remove outermost sequence</button>
						<p v-if="chain.length >= MAX_SUBTITLE_PREVIEW_ANCESTORS" class="notice">Preview supports up to {{ MAX_SUBTITLE_PREVIEW_ANCESTORS }} enclosing programs.</p>
						<p>Enclosing sequences use their saved settings. The current program uses its unsaved draft.</p>
					</template>
					<label><span>Preview library</span><select v-model="libraryId"><option value="">Choose a library</option><option v-for="library in libraries" :key="library.id" :value="library.id">{{ library.name }}</option></select></label>
					<p v-if="!libraries.length">Add and scan a library to check subtitle selection.</p>
					<label v-if="libraryId"><span>Search preview videos</span><input v-model="search" type="search" placeholder="Search by title" /></label>
					<p v-if="libraryId && !search.trim()">Search for a video to check subtitle selection.</p>
					<LoadingState v-if="itemsLoading" label="Loading preview videos…" />
					<p v-if="itemsError" class="notice error">{{ itemsError }} <button type="button" class="button secondary contextual" @click="browse">Retry videos</button></p>
					<template v-if="itemsLoaded">
						<p v-if="!items.length">No videos match this search.</p>
						<div v-if="items.length" class="subtitle-preview-videos" role="group" aria-label="Preview videos">
							<button v-for="item in items" :key="item.id" class="subtitle-preview-video" :title="item.title" type="button" :aria-pressed="mediaId === item.id" :disabled="invalid || !contextValid" @click="selectVideo(item.id)">
								<span class="poster subtitle-preview-poster">
									<Film class="poster-placeholder" :size="28" aria-hidden="true" />
									<img v-if="item.artworkUrl" :src="artworkVariantUrl(item.artworkUrl, 'card')" :srcset="artworkSrcset(item.artworkUrl, 'card')" alt="" loading="lazy" decoding="async" @error="hideBrokenImage" />
								</span>
								<strong>{{ item.title }}</strong>
								<small>{{ item.seasonNumber !== null ? `S${item.seasonNumber} · E${item.episodeNumber}` : item.year || item.kind }}</small>
								<small v-if="mediaSearchMatchText(item.matches)" class="source-match-context" :title="`Matched ${mediaSearchMatchText(item.matches)}`">Matched {{ mediaSearchMatchText(item.matches) }}</small>
							</button>
						</div>
						<p v-if="items.length" class="subtitle-preview-selection-hint">Select an item to check its subtitles.</p>
					</template>
					<p v-if="inherit && !contextValid" class="notice">Choose a preview channel and valid inheritance context before selecting a video.</p>
					<p v-if="invalid" class="notice">Complete the specific subtitle rules before checking.</p>
				</template>
				<LoadingState v-if="checking || refreshPending" label="Checking selection…" />
				<p v-if="checkError" class="notice error">{{ checkError }}</p>
				<p v-if="stale" class="notice" role="status">This result is outdated.</p>
				<SubtitleSelectionPreviewResultView v-if="result" :result="result" />
			</div>
		</FormDisclosure>
	</section>
</template>
