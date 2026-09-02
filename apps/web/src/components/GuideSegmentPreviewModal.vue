<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { RouterLink } from 'vue-router';
import { Asterisk, Clock3, Film, Folder, Layers3, ListVideo, X } from '@lucide/vue';
import type { GuideSegmentDetail } from '@moirai/shared';
import { artworkSrcset, artworkVariantUrl } from '../artwork-url';
import { compactDurationLabel } from '../duration-format';
import { instantLabel } from '../time-format';
import { useAnimatedDismissal } from '../motion';

const props = defineProps<{
	detail: GuideSegmentDetail | null;
	loading: boolean;
	error: string;
	timeZone: string;
}>();

const emit = defineEmits<{ close: [] }>();
const dialog = ref<HTMLElement>();
const { visible, requestClose, finishClose } = useAnimatedDismissal(() => emit('close'));

onMounted(() => dialog.value?.focus());

/** Format elapsed seconds as a compact duration for a guide preview. */
function durationLabel(seconds: number | null): string {
	return compactDurationLabel(seconds, 'Duration unavailable');
}

/** Format one guide instant in the configured channel time zone. */
function timeLabel(value: string): string {
	return instantLabel(value, {
		weekday: 'short',
		month: 'short',
		day: 'numeric',
		hour: 'numeric',
		minute: '2-digit',
	}, props.timeZone);
}

/** Build compact movie or episode coordinates for the selected media. */
const mediaCoordinates = computed(() => {
	const media = props.detail?.media;
	if (!media) {
		return '';
	}

	if (media.kind === 'episode') {
		return `S${media.seasonNumber ?? 0}E${media.episodeNumber ?? 0}`;
	}

	return media.year ? String(media.year) : '';
});

/** Describe the scheduling role in user-facing language. */
const roleLabel = computed(() => {
	if (props.detail?.source.role === 'filler') {
		return 'Filler content';
	}

	if (props.detail?.source.role === 'dead-air') {
		return 'No programming';
	}

	return 'Primary programming';
});
</script>

<template>
	<Transition name="moirai-overlay" appear @after-leave="finishClose">
		<div
			v-show="visible"
			:inert="!visible"
			:aria-hidden="!visible"
			class="moirai-dialog-backdrop guide-preview-backdrop"
			role="presentation"
			@mousedown.self="requestClose"
		>
			<section
				ref="dialog"
				class="moirai-dialog guide-preview-modal"
				role="dialog"
				aria-modal="true"
				aria-labelledby="guide-preview-title"
				tabindex="-1"
				@keydown.esc="requestClose"
			>
				<div class="modal-heading">
					<div>
						<p class="eyebrow">Schedule item</p>
						<h2 id="guide-preview-title">{{ detail?.segment.title ?? 'Programme details' }}</h2>
					</div>
					<button class="icon-button" type="button" aria-label="Close" @click="requestClose">
						<X :size="20" />
					</button>
				</div>

				<div v-if="loading" class="guide-preview-loading" aria-live="polite">
					Loading schedule item…
				</div>
				<p v-else-if="error" class="notice error">{{ error }}</p>
				<div v-else-if="detail" class="guide-preview-layout">
					<div class="guide-preview-poster">
						<Asterisk :size="38" />
						<img
							v-if="detail.media?.artworkUrl"
							:src="artworkVariantUrl(detail.media.artworkUrl, 'card')"
							:srcset="artworkSrcset(detail.media.artworkUrl, 'card')"
							:alt="`${detail.media.title} artwork`"
						/>
					</div>
					<div class="guide-preview-copy">
						<div class="guide-preview-badges">
							<span>{{ roleLabel }}</span>
							<span v-if="mediaCoordinates">{{ mediaCoordinates }}</span>
							<span v-if="detail.media">{{ durationLabel(detail.media.durationSeconds) }}</span>
							<span v-if="detail.segment.truncated">Truncated</span>
						</div>
						<p class="guide-preview-airtime">
							<Clock3 :size="16" />
							{{ timeLabel(detail.segment.start) }} – {{ timeLabel(detail.segment.finish) }}
						</p>
						<p v-if="detail.media?.plot" class="guide-preview-plot">{{ detail.media.plot }}</p>
						<div v-if="detail.media?.genreNames.length" class="guide-preview-genres">
							<span v-for="genre in detail.media.genreNames" :key="genre">{{ genre }}</span>
						</div>
						<p v-if="detail.media && !detail.catalogItemPresent" class="notice warning">
							This item is no longer in the current index. Its committed guide metadata is shown.
						</p>
						<p
							v-else-if="detail.media?.availability !== 'available'"
							class="notice warning"
						>
							The media source is temporarily unavailable.
						</p>
						<div class="guide-preview-source">
							<h3>Schedule source</h3>
							<p><ListVideo :size="16" /><span>Program</span><strong>{{ detail.source.programName ?? 'None' }}</strong></p>
							<p><Layers3 :size="16" /><span>Template</span><strong>{{ detail.source.templateName ?? 'Unavailable' }}</strong></p>
							<p><Folder :size="16" /><span>Library</span><strong>{{ detail.source.libraryName ?? 'None' }}</strong></p>
						</div>
						<RouterLink
							v-if="detail.media && detail.catalogItemPresent"
							class="button guide-preview-details"
							:to="`/libraries/${detail.media.libraryId}/items/${detail.media.id}`"
							@click="emit('close')"
						>
							<Film :size="17" />View Media Details
						</RouterLink>
					</div>
				</div>
			</section>
		</div>
	</Transition>
</template>
