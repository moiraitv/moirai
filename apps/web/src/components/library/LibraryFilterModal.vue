<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, useTemplateRef, watch } from 'vue';
import { CalendarDays, Check, Filter, Search, Star, UserRound, X } from '@lucide/vue';
import { MAX_MEDIA_GENRE_RULES, type MediaGenreFacet } from '@moirai/shared';
import { api } from '../../api';
import { countLabel } from '../../count-label';
import { useAnimatedDismissal } from '../../motion';
import {
	emptyLibraryFilterDraft,
	type LibraryFilterDraft,
} from './library-filter';

const props = defineProps<{
	libraryId: string;
	libraryType?: string | undefined;
	draft: LibraryFilterDraft;
	genres: MediaGenreFacet[];
}>();
const emit = defineEmits<{ apply: [draft: LibraryFilterDraft]; close: [] }>();
const { visible, requestClose, finishClose } = useAnimatedDismissal(() => emit('close'));
const genreMatchInput = useTemplateRef<HTMLInputElement>('genreMatchInput');
const localDraft = reactive<LibraryFilterDraft>({
	...props.draft,
	genres: [...props.draft.genres],
	excludedGenres: [...props.draft.excludedGenres],
});
const contextualGenres = ref<MediaGenreFacet[] | null>(null);
const genreCountsLoading = ref(false);
const genreCountsError = ref(false);
const displayedGenres = computed(() => contextualGenres.value ?? props.genres);
const selectedGenreRuleCount = computed(
	() => localDraft.genres.length + localDraft.excludedGenres.length,
);
const genreRuleLimitReached = computed(
	() => selectedGenreRuleCount.value >= MAX_MEDIA_GENRE_RULES,
);
const genreRuleLimitExceeded = computed(
	() => selectedGenreRuleCount.value > MAX_MEDIA_GENRE_RULES,
);
let genreCountsController: AbortController | undefined;

/** Reset the uncommitted controls without changing the active catalog query. */
function clearDraft(): void {
	Object.assign(localDraft, emptyLibraryFilterDraft());
}

/** Commit an independent snapshot so later edits cannot mutate applied route state. */
function applyDraft(): void {
	if (genreRuleLimitExceeded.value) {
		return;
	}

	emit('apply', {
		...localDraft,
		genres: [...localDraft.genres],
		excludedGenres: localDraft.genreMatch === 'all'
			? [...localDraft.excludedGenres]
			: [],
	});
}

/** Return the active Match all rule for one genre. */
function genreRule(key: string): 'include' | 'exclude' | null {
	if (localDraft.genres.includes(key)) {
		return 'include';
	}

	return localDraft.excludedGenres.includes(key) ? 'exclude' : null;
}

/** Activate, switch, or clear one required/disallowed genre rule. */
function toggleGenreRule(key: string, rule: 'include' | 'exclude'): void {
	const current = genreRule(key);
	if (current === null && genreRuleLimitReached.value) {
		return;
	}

	localDraft.genres = localDraft.genres.filter((genre) => genre !== key);
	localDraft.excludedGenres = localDraft.excludedGenres.filter((genre) => genre !== key);
	if (current === rule) {
		return;
	}

	if (rule === 'include') {
		localDraft.genres.push(key);
	}
	else {
		localDraft.excludedGenres.push(key);
	}
}

/** Return whether a neutral genre cannot gain a rule because the query limit is reached. */
function genreRuleDisabled(key: string): boolean {
	return genreRule(key) === null && genreRuleLimitReached.value;
}

/** Describe a prospective genre action for assistive technology. */
function genreActionLabel(
	genre: MediaGenreFacet,
	rule: 'include' | 'exclude',
): string {
	const count = rule === 'include' ? genre.count : genre.excludeCount;
	const action = rule === 'include' ? 'Require' : 'Disallow';
	return count === null
		? `${action} ${genre.name}`
		: `${action} ${genre.name}, ${countLabel(count, 'matching item')}`;
}

/**
 * Refresh prospective Match all counts while preventing superseded requests from replacing newer
 * checkbox state. Static library totals remain usable while the contextual query is unavailable.
 */
async function refreshGenreCounts(): Promise<void> {
	genreCountsController?.abort();
	genreCountsController = undefined;
	contextualGenres.value = null;
	genreCountsError.value = false;

	if (localDraft.genreMatch !== 'all') {
		genreCountsLoading.value = false;
		return;
	}

	const controller = new AbortController();
	genreCountsController = controller;
	genreCountsLoading.value = true;
	try {
		const facets = await api.mediaGenres(props.libraryId, {
			genreMatch: 'all',
			genres: localDraft.genres,
			excludedGenres: localDraft.excludedGenres,
		}, controller.signal);
		if (genreCountsController === controller) {
			contextualGenres.value = facets;
		}
	}
	catch {
		if (!controller.signal.aborted && genreCountsController === controller) {
			genreCountsError.value = true;
		}
	}
	finally {
		if (genreCountsController === controller) {
			genreCountsController = undefined;
			genreCountsLoading.value = false;
		}
	}
}

onMounted(() => genreMatchInput.value?.focus());
watch(() => localDraft.genreMatch, (value) => {
	if (value === 'any') {
		localDraft.excludedGenres = [];
	}
}, { flush: 'sync' });
watch(
	[
		() => props.libraryId,
		() => props.genres,
		() => localDraft.genreMatch,
		() => localDraft.genres.join('\u0000'),
		() => localDraft.excludedGenres.join('\u0000'),
	],
	() => void refreshGenreCounts(),
	{ immediate: true },
);
onUnmounted(() => genreCountsController?.abort());
</script>

<template>
	<Transition name="moirai-overlay" appear @after-leave="finishClose">
		<div v-show="visible" class="moirai-dialog-backdrop" :inert="!visible" :aria-hidden="!visible" @click.self="requestClose" @keydown.esc.stop.prevent="requestClose">
			<form
				v-modal-focus="{ escape: requestClose }"
				class="moirai-dialog filter-modal" role="dialog"
				aria-modal="true"
				aria-labelledby="library-filter-title"
				aria-describedby="library-filter-description"
				@submit.prevent="applyDraft"
			>
				<header class="filter-modal-header">
					<div>
						<p class="eyebrow">Library</p>
						<h2 id="library-filter-title">Filter media</h2>
						<p id="library-filter-description">Narrow down your results using the filters below.</p>
					</div>
					<button type="button" class="icon-button" aria-label="Close filters" @click="requestClose"><X :size="22" /></button>
				</header>

				<div class="filter-modal-body">
					<section class="filter-genres" aria-labelledby="filter-genres-title">
						<div class="filter-genres-header">
							<div class="filter-genres-copy">
								<div><h3 id="filter-genres-title">Genres</h3><p>Select genres to require or disallow in your results.</p></div>
							</div>
							<fieldset class="genre-match">
								<legend class="sr-only">Genre matching behavior</legend>
								<label><input ref="genreMatchInput" v-model="localDraft.genreMatch" type="radio" value="any" /><span><strong>Match any</strong><small>Results with any selected genre</small></span></label>
								<label><input v-model="localDraft.genreMatch" type="radio" value="all" /><span><strong>Match all</strong><small>Results with all selected genres</small></span></label>
							</fieldset>
						</div>
						<fieldset class="genre-choices" :aria-busy="genreCountsLoading">
							<legend class="sr-only">Select genres</legend>
							<template v-for="genre in displayedGenres" :key="genre.key">
								<div v-if="localDraft.genreMatch === 'all'" class="genre-choice-row">
									<div class="genre-rule-split" role="group" :aria-label="`${genre.name} rule`">
										<button type="button" :class="{ active: genreRule(genre.key) === 'include' }" :disabled="genreRuleDisabled(genre.key)" :aria-pressed="genreRule(genre.key) === 'include'" :aria-label="genreActionLabel(genre, 'include')" @click="toggleGenreRule(genre.key, 'include')"><Check :size="16" aria-hidden="true" /><small>{{ genre.count.toLocaleString() }}</small></button>
										<button type="button" class="exclude" :class="{ active: genreRule(genre.key) === 'exclude' }" :disabled="genreRuleDisabled(genre.key)" :aria-pressed="genreRule(genre.key) === 'exclude'" :aria-label="genreActionLabel(genre, 'exclude')" @click="toggleGenreRule(genre.key, 'exclude')"><X :size="16" aria-hidden="true" /><small>{{ genre.excludeCount?.toLocaleString() ?? '—' }}</small></button>
									</div>
									<span class="genre-choice-name">{{ genre.name }}</span>
								</div>
								<label v-else><input v-model="localDraft.genres" type="checkbox" :value="genre.key" :disabled="!localDraft.genres.includes(genre.key) && genreRuleLimitReached" /><span>{{ genre.name }}</span><small>{{ genre.count.toLocaleString() }}</small></label>
							</template>
							<p v-if="displayedGenres.length === 0" class="genre-choices-empty">No genres have been indexed for this library.</p>
						</fieldset>
						<p v-if="genreRuleLimitReached" class="genre-count-status" :class="{ error: genreRuleLimitExceeded }" role="status">
							{{ genreRuleLimitExceeded ? `Remove genre rules to stay within the ${MAX_MEDIA_GENRE_RULES}-rule limit.` : `The ${MAX_MEDIA_GENRE_RULES}-rule genre limit has been reached.` }}
						</p>
						<p v-if="genreCountsLoading" class="genre-count-status" role="status">Updating genre counts…</p>
						<p v-else-if="genreCountsError" class="genre-count-status error" role="status">Could not refresh counts. Showing library totals.</p>
					</section>

					<div class="filter-grid">
						<label class="filter-field filter-name-field">
							<span>Name</span>
							<span class="filter-input"><input v-model="localDraft.name" placeholder="Partial title" /><Search :size="21" aria-hidden="true" /></span>
						</label>

						<fieldset class="filter-range-field">
							<legend>Release year</legend>
							<div class="filter-range-inputs">
								<label class="filter-field">
									<span>From</span>
									<span class="filter-input"><input v-model="localDraft.releaseFrom" type="number" inputmode="numeric" min="1800" max="2200" placeholder="YYYY" /><CalendarDays :size="19" aria-hidden="true" /></span>
								</label>
								<label class="filter-field">
									<span>To</span>
									<span class="filter-input"><input v-model="localDraft.releaseTo" type="number" inputmode="numeric" min="1800" max="2200" placeholder="YYYY" /><CalendarDays :size="19" aria-hidden="true" /></span>
								</label>
							</div>
						</fieldset>

						<fieldset class="filter-range-field">
							<legend>Added</legend>
							<div class="filter-range-inputs">
								<label class="filter-field">
									<span>From</span>
									<span class="filter-input"><input v-model="localDraft.addedFrom" type="date" /><CalendarDays :size="19" aria-hidden="true" /></span>
								</label>
								<label class="filter-field">
									<span>To</span>
									<span class="filter-input"><input v-model="localDraft.addedTo" type="date" /><CalendarDays :size="19" aria-hidden="true" /></span>
								</label>
							</div>
						</fieldset>

						<label class="filter-field">
							<span>Minimum popular rating</span>
							<span class="filter-input"><input v-model="localDraft.minimumRating" type="number" inputmode="decimal" min="0" max="10" step="0.1" placeholder="0–10" /><Star :size="19" aria-hidden="true" /></span>
						</label>
						<label class="filter-field">
							<span>Minimum user rating</span>
							<span class="filter-input"><input v-model="localDraft.minimumUserRating" type="number" inputmode="decimal" min="0" max="10" step="0.1" placeholder="0–10" /><UserRound :size="19" aria-hidden="true" /></span>
						</label>
					</div>

					<div class="filter-people-grid">
						<label class="filter-field">
							<span>Actor</span>
							<span class="filter-input"><input v-model="localDraft.actor" placeholder="Partial actor name" /><UserRound :size="20" aria-hidden="true" /></span>
						</label>
						<label class="filter-field">
							<span>Director</span>
							<span class="filter-input"><input v-model="localDraft.director" placeholder="Partial director name" /><UserRound :size="20" aria-hidden="true" /></span>
						</label>
						<label v-if="libraryType === 'music-videos' || draft.artist" class="filter-field"><span>Artist</span><span class="filter-input"><input v-model="localDraft.artist" placeholder="Partial artist name" /><UserRound :size="20" aria-hidden="true" /></span></label>
						<label v-if="libraryType === 'music-videos' || draft.album" class="filter-field"><span>Album</span><span class="filter-input"><input v-model="localDraft.album" placeholder="Partial album name" /><Search :size="20" aria-hidden="true" /></span></label>
					</div>
				</div>

				<footer class="filter-modal-footer">
					<button type="button" class="button ghost" @click="clearDraft">Clear All</button>
					<button type="button" class="button secondary" @click="requestClose">Cancel</button>
					<button class="button filter-apply" type="submit" :disabled="genreRuleLimitExceeded">Apply Filters <Filter :size="17" aria-hidden="true" /></button>
				</footer>
			</form>
		</div>
	</Transition>
</template>
