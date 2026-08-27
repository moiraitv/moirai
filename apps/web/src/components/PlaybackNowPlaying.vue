<script setup lang="ts">
import { computed } from 'vue';
import { Asterisk } from '@lucide/vue';
import type { PlaybackNowPlayingStatus } from '@moirai/shared';
import { artworkSrcset, artworkVariantUrl } from '../artwork-url';
import { hideBrokenImage } from '../image-error';
import { playbackPositionIndicator } from '../playback-session-format';

/** Current committed programming and display clock used by the live position indicator. */
interface PlaybackNowPlayingProps {
	item: PlaybackNowPlayingStatus | null;
	nowMs: number;
}

const props = defineProps<PlaybackNowPlayingProps>();
const position = computed(() => props.item
	? playbackPositionIndicator(props.item, props.nowMs)
	: null);
</script>

<template>
	<section class="playback-now-playing">
		<p class="eyebrow playback-activity-heading">Now playing</p>
		<div v-if="item" class="playback-now-playing-content">
			<span class="playback-now-playing-poster">
				<Asterisk :size="22" />
				<img
					v-if="item.artworkUrl"
					:src="artworkVariantUrl(item.artworkUrl, 'thumb')"
					:srcset="artworkSrcset(item.artworkUrl, 'thumb')"
					alt=""
					loading="lazy"
					decoding="async"
					@error="hideBrokenImage"
				/>
			</span>
			<div class="playback-now-playing-copy">
				<strong :title="item.title">{{ item.title }}</strong>
				<div
					class="playback-position-track"
					role="progressbar"
					aria-label="Current program position"
					aria-valuemin="0"
					aria-valuemax="100"
					:aria-valuenow="Math.round(position?.percent ?? 0)"
				>
					<i :style="{ width: `${position?.percent ?? 0}%` }"></i>
				</div>
				<small v-if="position" class="playback-position-label">
					<span>{{ position.elapsed }}</span>
					<span>{{ position.duration }}</span>
				</small>
			</div>
		</div>
		<small v-else class="playback-programming-empty">
			No committed programming at the current time
		</small>
	</section>
</template>
