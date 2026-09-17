<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue';
import { Asterisk, Search, Trash2 } from '@lucide/vue';
import type { ViewingPreferenceSummary } from '@moirai/shared';
import { artworkSrcset, artworkVariantUrl } from '../artwork-url';
import { hideBrokenImage } from '../image-error';
import LoadingState from './LoadingState.vue';
import MediaCardPreview from './MediaCardPreview.vue';
import ResourceEditorHeader from './ResourceEditorHeader.vue';
import TwoStepActionButton from './TwoStepActionButton.vue';

defineProps<{
	preferences: ViewingPreferenceSummary[];
	loading: boolean;
	clearing: boolean;
	error: string;
	clearError: string;
}>();
const emit = defineEmits<{
	close: [];
	search: [title: string];
	clear: [];
}>();
const titleQuery = ref('');
let searchTimer: ReturnType<typeof setTimeout> | undefined;

watch(titleQuery, (value) => {
	if (searchTimer !== undefined) {
		clearTimeout(searchTimer);
	}

	searchTimer = setTimeout(() => {
		emit('search', value);
	}, 250);
});

onBeforeUnmount(() => {
	if (searchTimer !== undefined) {
		clearTimeout(searchTimer);
	}
});

/** Format one decayed preference score for an understandable compact ranking. */
function preferenceScore(value: number): string {
	return value.toFixed(value >= 10 ? 1 : 2);
}
</script>

<template>
	<div class="moirai-dialog-backdrop" @click.self="emit('close')">
		<div
			v-modal-focus="{ escape: () => emit('close') }"
			class="moirai-dialog viewing-scores-modal"
			role="dialog"
			aria-modal="true"
			aria-labelledby="viewing-scores-title"
		>
			<ResourceEditorHeader close-label="Close current scores" @close="emit('close')">
				<p class="eyebrow">Weighted random</p>
				<h2 id="viewing-scores-title">Current scores</h2>
				<p>Decayed preferences used when a program selects by weighted random.</p>
			</ResourceEditorHeader>
			<div class="resource-editor-scroll viewing-scores-body">
				<label class="viewing-scores-search">
					<Search :size="16" aria-hidden="true" />
					<input
						v-model="titleQuery"
						type="search"
						placeholder="Search titles"
						aria-label="Search titles"
					/>
				</label>
				<LoadingState v-if="loading && preferences.length === 0" label="Loading learned preferences…" />
				<div v-else-if="error">
					<p class="notice error" role="alert">{{ error }}</p>
					<button type="button" class="button secondary" @click="emit('search', titleQuery)">Retry History</button>
				</div>
				<p v-else-if="preferences.length === 0" class="muted">{{ titleQuery.trim() ? 'No matching scores.' : 'No qualified viewing has been recorded yet.' }}</p>
				<ol v-else class="viewing-preference-list">
					<li v-for="preference in preferences" :key="`${preference.kind}:${preference.id}`">
						<MediaCardPreview
							:item="{
								id: preference.previewItemId,
								title: preference.title,
								year: preference.year,
								artworkUrl: preference.artworkUrl,
							}"
							hide-info
						>
							<article class="viewing-score-row">
								<span class="viewing-score-poster">
									<Asterisk :size="22" />
									<img
										v-if="preference.artworkUrl"
										:src="artworkVariantUrl(preference.artworkUrl, 'card')"
										:srcset="artworkSrcset(preference.artworkUrl, 'card')"
										:alt="`${preference.title} artwork`"
										loading="lazy"
										decoding="async"
										@error="hideBrokenImage"
									/>
								</span>
								<span class="viewing-score-copy">
									<strong>{{ preference.title }}</strong>
									<small v-if="preference.parentTitle">{{ preference.parentTitle }}</small>
									<small>
										{{ [preference.kind === 'show' ? 'Show' : null, preference.subtitle].filter(Boolean).join(' · ') }}
										· Last viewed {{ new Date(preference.lastViewedAt).toLocaleDateString() }}
									</small>
								</span>
								<output>{{ preferenceScore(preference.score) }}</output>
							</article>
						</MediaCardPreview>
					</li>
				</ol>
			</div>
			<footer class="viewing-scores-footer">
				<p v-if="clearError" class="notice error" role="alert">{{ clearError }}</p>
				<TwoStepActionButton
					class="button secondary"
					label="Clear History"
					confirm-label="Confirm Clear History"
					confirm-text="Confirm Clear"
					:disabled="loading || clearing"
					@confirm="emit('clear')"
				>
					<Trash2 :size="17" />{{ clearing ? 'Clearing…' : 'Clear History' }}
				</TwoStepActionButton>
			</footer>
		</div>
	</div>
</template>
