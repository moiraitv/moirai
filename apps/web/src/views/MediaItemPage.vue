<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
	ArrowLeft,
	Asterisk,
	CalendarDays,
	CheckCircle2,
	Clock3,
	Copy,
	File,
	FolderOpen,
	Gauge,
	HardDrive,
	ListPlus,
	Play,
	Star,
	Users,
	Video,
	X,
} from '@lucide/vue';
import type { MediaItemDetail, ProgramItemAdditionResult } from '@moirai/shared';
import { api } from '../api';
import LoadingState from '../components/LoadingState.vue';
import { artworkSrcset, artworkVariantUrl } from '../artwork-url';
import { errorMessage } from '../error-message';
import { hideBrokenImage } from '../image-error';
import { compactDurationLabel } from '../duration-format';
import AddItemsToProgramModal from '../components/programs/AddItemsToProgramModal.vue';
import ProgramAdditionToast from '../components/programs/ProgramAdditionToast.vue';
import { countLabel } from '../count-label';

const route = useRoute();
const router = useRouter();
const item = ref<MediaItemDetail>();
const error = ref('');
const loading = ref(true);
const showPlayer = ref(false);
const playerError = ref('');
const player = ref<HTMLVideoElement>();
const playerDialog = ref<HTMLElement>();
const playButton = ref<HTMLButtonElement>();
const showAllCredits = ref(false);
const copyStatus = ref('');
const addToProgramOpen = ref(false);
const programAdditionResult = ref<ProgramItemAdditionResult | null>(null);
const id = computed(() => String(route.params.id));
const previewUrl = computed(() => `/api/v1/media/${encodeURIComponent(id.value)}/preview`);
const visibleActors = computed(() => {
	if (!item.value || showAllCredits.value) {
		return item.value?.actors ?? [];
	}

	return item.value.actors.slice(0, 5);
});
const hasCredits = computed(() =>
	Boolean(
		item.value
		&& (item.value.directors.length
			|| item.value.writers.length
			|| item.value.actors.length
			|| item.value.studios.length
			|| item.value.countries.length),
	));

/** Format media duration into a compact hours-and-minutes label. */
function duration(value: number | null): string {
	return compactDurationLabel(value, 'Unknown runtime');
}

/** Format byte length using an appropriate binary unit. */
function fileSize(value: number | null): string {
	if (value === null) {
		return 'Unavailable';
	}

	const units = ['B', 'KB', 'MB', 'GB', 'TB'];
	let size = value;
	let unit = 0;
	while (size >= 1024 && unit < units.length - 1) {
		size /= 1024;
		unit += 1;
	}
	return `${size.toFixed(unit === 0 ? 0 : 2)} ${units[unit]}`;
}

/** Return the user-facing label for kind. */
function kindLabel(value: string): string {
	return value
		.split('-')
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(' ');
}

/** Return to the previous catalog location or the library root. */
function back(): void {
	if (window.history.length > 1) {
		router.back();
	}
	else {
		void router.push(`/libraries/${String(route.params.libraryId)}`);
	}
}

/** Copy a source path and report whether clipboard access succeeded. */
async function copyPath(value: string, label: string): Promise<void> {
	try {
		await navigator.clipboard.writeText(value);
		copyStatus.value = `${label} copied`;
	}
	catch {
		copyStatus.value = `Unable to copy ${label.toLowerCase()}`;
	}
}

/** Open the preview dialog, transfer focus, and request playback. */
async function openPlayer(): Promise<void> {
	playerError.value = '';
	showPlayer.value = true;
	await nextTick();
	playerDialog.value?.focus();
	void player.value?.play().catch(() => undefined);
}

/** Pause playback, close the dialog, and restore focus to its trigger. */
function closePlayer(): void {
	player.value?.pause();
	showPlayer.value = false;
	playerError.value = '';
	void nextTick(() => playButton.value?.focus());
}

/** Close the destination dialog and report the selected-items program that changed. */
function finishProgramAddition(result: ProgramItemAdditionResult): void {
	addToProgramOpen.value = false;
	programAdditionResult.value = result;
}

/** Translate browser media failures into safe, actionable preview messages. */
function handlePlayerError(): void {
	const code = player.value?.error?.code;
	playerError.value
		= code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED
			? 'This browser cannot directly play this file format or codec.'
			: 'The preview could not be loaded. The media source may be temporarily unavailable.';
}

/** Load the selected media item and its presentation metadata. */
async function load(): Promise<void> {
	loading.value = true;
	error.value = '';
	try {
		item.value = await api.mediaItem(id.value);
	}
	catch (cause) {
		error.value = errorMessage(cause);
	}
	finally {
		loading.value = false;
	}
}

watch(id, () => {
	closePlayer();
	addToProgramOpen.value = false;
	programAdditionResult.value = null;
	void load();
});
onMounted(() => void load());
onUnmounted(closePlayer);
</script>

<template>
	<LoadingState v-if="loading" label="Loading media details…" />
	<div v-else-if="error" class="notice error">
		{{ error }}
		<button class="button ghost" @click="load">Retry</button>
	</div>
	<section v-else-if="item" class="media-detail-page">
		<button class="detail-back" @click="back">
			<span><ArrowLeft :size="20" /></span>
			Back to Library
		</button>

		<div class="media-detail-hero">
			<div class="detail-artwork-column">
				<div class="detail-poster">
					<Asterisk :size="58" />
					<img
						v-if="item.artworkUrl"
						:src="artworkVariantUrl(item.artworkUrl, 'detail')"
						:srcset="artworkSrcset(item.artworkUrl, 'detail')"
						:alt="`${item.title} poster`"
						@error="hideBrokenImage"
					/>
				</div>
				<div class="detail-actions">
					<button ref="playButton" class="button primary detail-play" @click="openPlayer">
						<Play :size="19" fill="currentColor" />
						Play Preview
					</button>
					<button class="button secondary" @click="addToProgramOpen = true">
						<ListPlus :size="19" />
						Add to Program
					</button>
				</div>
			</div>

			<div class="detail-copy">
				<p class="eyebrow">{{ kindLabel(item.kind) }}</p>
				<h1>{{ item.title }}</h1>
				<p v-if="item.groupTrail.length" class="detail-trail">
					{{ item.groupTrail.map((group) => group.title).join(' / ') }}
				</p>
				<div class="detail-facts">
					<span v-if="item.year"><CalendarDays :size="17" />{{ item.year }}</span>
					<span><Clock3 :size="17" />{{ duration(item.durationSeconds) }}</span>
					<span v-if="item.certification"><Video :size="17" />{{ item.certification }}</span>
					<span v-if="item.rating !== null"
					><Star :size="17" class="rating-star" />{{ item.rating.toFixed(1) }}</span
					>
					<span v-if="item.seasonNumber !== null">
						<Video :size="17" />S{{ item.seasonNumber }}E{{ item.episodeNumber ?? 0
						}}{{ item.episodeEndNumber !== null ? `–E${item.episodeEndNumber}` : '' }}
					</span>
					<span v-if="item.edition"><File :size="17" />{{ item.edition }}</span>
					<span v-if="item.trackNumber !== null">
						<File :size="17" />{{ item.discNumber !== null ? `Disc ${item.discNumber} · ` : ''
						}}Track {{ item.trackNumber }}
					</span>
				</div>
				<p class="detail-plot">{{ item.plot || 'No plot summary is available.' }}</p>
				<p v-if="item.availability !== 'available'" class="notice warning detail-availability">
					This item was not observed during the latest healthy source scan. Preview will still be
					attempted, but it remains excluded from scheduling until it is observed again.
				</p>
				<div v-if="item.genres.length" class="detail-tags">
					<span v-for="genre in item.genres" :key="genre">{{ genre }}</span>
				</div>
			</div>
		</div>

		<div class="detail-panels">
			<article class="panel detail-panel">
				<h2><Users :size="22" />Credits</h2>
				<dl v-if="hasCredits">
					<template v-if="item.directors.length">
						<dt>{{ item.directors.length === 1 ? 'Director' : 'Directors' }}</dt>
						<dd>{{ item.directors.join(', ') }}</dd>
					</template>
					<template v-if="item.writers.length">
						<dt>{{ item.writers.length === 1 ? 'Writer' : 'Writers' }}</dt>
						<dd>{{ item.writers.join(', ') }}</dd>
					</template>
					<template v-if="item.actors.length">
						<dt>Stars</dt>
						<dd>
							{{
								visibleActors
									.map((actor) => (actor.role ? `${actor.name} (${actor.role})` : actor.name))
									.join(', ')
							}}
						</dd>
					</template>
					<template v-if="item.studios.length">
						<dt>{{ item.studios.length === 1 ? 'Studio' : 'Studios' }}</dt>
						<dd>{{ item.studios.join(', ') }}</dd>
					</template>
					<template v-if="item.countries.length">
						<dt>{{ item.countries.length === 1 ? 'Country' : 'Countries' }}</dt>
						<dd>{{ item.countries.join(', ') }}</dd>
					</template>
				</dl>
				<p v-else class="detail-empty-copy">No credit metadata is available.</p>
				<button
					v-if="item.actors.length > 5"
					class="button ghost detail-credits-toggle"
					@click="showAllCredits = !showAllCredits"
				>
					{{ showAllCredits ? 'Show Featured Cast' : 'View Full Cast & Crew' }}
				</button>
			</article>

			<article class="panel detail-panel detail-source-panel">
				<h2><FolderOpen :size="22" />Source</h2>
				<dl>
					<dt><File :size="18" />Library path</dt>
					<dd>
						<span>{{ item.relativePath }}</span>
						<button
							class="detail-copy-button"
							title="Copy library path"
							aria-label="Copy library path"
							@click="copyPath(item.relativePath, 'Library path')"
						>
							<Copy :size="17" />
						</button>
					</dd>
					<dt><File :size="18" />Playback path</dt>
					<dd>
						<span>{{ item.playbackPath }}</span>
						<button
							class="detail-copy-button"
							title="Copy playback path"
							aria-label="Copy playback path"
							@click="copyPath(item.playbackPath, 'Playback path')"
						>
							<Copy :size="17" />
						</button>
					</dd>
					<dt><CalendarDays :size="18" />Date added</dt>
					<dd>{{ new Date(item.dateAddedAt).toLocaleString() }}</dd>
					<dt><Gauge :size="18" />Resolution</dt>
					<dd>
						{{
							item.resolution ? `${item.resolution.width} × ${item.resolution.height}` : 'Unknown'
						}}
					</dd>
					<dt><Clock3 :size="18" />Duration</dt>
					<dd>{{ duration(item.durationSeconds) }}</dd>
					<dt><HardDrive :size="18" />File size</dt>
					<dd>{{ fileSize(item.fileSizeBytes) }}</dd>
					<dt><Gauge :size="18" />Container</dt>
					<dd>{{ item.container ?? 'Unknown' }}</dd>
					<template v-if="item.videoCodecs.length || item.audioCodecs.length">
						<dt><File :size="18" />Streams</dt>
						<dd>
							{{
								[
									item.videoCodecs.length ? `Video: ${item.videoCodecs.join(', ')}` : null,
									item.audioCodecs.length ? `Audio: ${item.audioCodecs.join(', ')}` : null,
								].filter(Boolean).join(' · ')
							}}
						</dd>
					</template>
					<dt><CheckCircle2 :size="18" />Playback inspection</dt>
					<dd class="metadata-state">
						<CheckCircle2 v-if="item.probeStatus === 'complete'" :size="19" />
						{{
							item.probeStatus === 'complete'
								? 'Measured from media file'
								: item.probeStatus === 'pending'
									? 'Waiting for scan'
									: 'Media inspection failed'
						}}
					</dd>
					<dt><File :size="18" />Metadata</dt>
					<dd class="metadata-state">
						<CheckCircle2 v-if="item.metadataStatus === 'complete'" :size="19" />
						{{ kindLabel(item.metadataStatus) }}
					</dd>
					<template v-if="item.parts.length > 1">
						<dt><File :size="18" />Multipart sequence</dt>
						<dd>{{ kindLabel(item.multipartStatus) }} · {{ countLabel(item.parts.length, 'part') }}</dd>
						<template v-for="part in item.parts" :key="part.relativePath">
							<dt>Part {{ part.number }}</dt>
							<dd>{{ part.relativePath }} · {{ duration(part.durationSeconds) }}</dd>
						</template>
					</template>
				</dl>
			</article>

			<article class="panel detail-panel">
				<h2><File :size="22" />Subtitles</h2>
				<dl v-if="item.subtitleTracks.length || item.parts.some((part) => part.subtitleTracks.length)">
					<template
						v-for="track in [
							...item.subtitleTracks,
							...item.parts.flatMap((part) => part.subtitleTracks),
						]"
						:key="track.id"
					>
						<dt>{{ track.language?.toUpperCase() || 'Unknown language' }}</dt>
						<dd>
							{{ kindLabel(track.sourceType) }}{{ track.partNumber ? ` · Part ${track.partNumber}` : ''
							}}{{ track.codec || track.format ? ` · ${track.codec ?? track.format}` : ''
							}}{{ track.isForced ? ' · Forced' : '' }}{{ track.isDefault ? ' · Default' : '' }}
						</dd>
					</template>
				</dl>
				<p v-else class="detail-empty-copy">No subtitle tracks were discovered.</p>
				<p class="detail-empty-copy">
					Subtitle tracks are indexed for future playback selection and do not change current playout.
				</p>
			</article>
		</div>
		<p class="visually-hidden" aria-live="polite">{{ copyStatus }}</p>
		<AddItemsToProgramModal
			v-if="addToProgramOpen"
			:library-id="item.libraryId"
			:selection="{ type: 'items', itemIds: [item.id] }"
			@added="finishProgramAddition"
			@close="addToProgramOpen = false"
		/>
		<ProgramAdditionToast v-if="programAdditionResult" :result="programAdditionResult" @close="programAdditionResult = null" />
	</section>

	<Teleport to="body">
		<div
			v-if="showPlayer && item"
			class="moirai-dialog-backdrop media-preview-backdrop"
			@click.self="closePlayer"
		>
			<section
				ref="playerDialog"
				class="media-preview-modal"
				role="dialog"
				aria-modal="true"
				:aria-label="`Preview ${item.title}`"
				tabindex="-1"
				@keydown.esc="closePlayer"
			>
				<header>
					<div>
						<p class="eyebrow">Preview</p>
						<h2>{{ item.title }}</h2>
					</div>
					<button class="media-preview-close" aria-label="Close preview" @click="closePlayer">
						<X :size="22" />
					</button>
				</header>
				<div class="media-preview-stage">
					<video
						ref="player"
						:src="previewUrl"
						:poster="artworkVariantUrl(item.artworkUrl, 'detail')"
						controls
						autoplay
						playsinline
						preload="metadata"
						@error="handlePlayerError"
					>
						Your browser does not support HTML video playback.
					</video>
				</div>
				<p v-if="playerError" class="notice error media-preview-error">{{ playerError }}</p>
				<p class="media-preview-note">
					Preview uses the original file. Seeking is available when its format and codecs are
					supported by this browser.
				</p>
			</section>
		</div>
	</Teleport>
</template>
