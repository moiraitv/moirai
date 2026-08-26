<script setup lang="ts">
import { reactive, watch } from 'vue';
import { X } from '@lucide/vue';
import type { GenreMatch, MediaGenreFacet } from '@moirai/shared';

/** Mutable filter values prepared before they are committed to the route. */
interface FilterDraft {
	name: string;
	releaseFrom: string;
	releaseTo: string;
	addedFrom: string;
	addedTo: string;
	genres: string[];
	genreMatch: GenreMatch;
	actor: string;
	director: string;
}

const props = defineProps<{ draft: FilterDraft; genres: MediaGenreFacet[] }>();
const emit = defineEmits<{ apply: []; clear: []; close: []; 'update:draft': [draft: FilterDraft] }>();
const localDraft = reactive<FilterDraft>({ ...props.draft, genres: [...props.draft.genres] });
watch(localDraft, (value) => emit('update:draft', { ...value, genres: [...value.genres] }), { deep: true });
</script>

<template>
	<div class="modal-backdrop" @click.self="emit('close')">
		<form class="modal filter-modal" @submit.prevent="emit('apply')">
			<header class="modal-heading"><div><p class="eyebrow">Library</p><h2>Filter media</h2></div><button type="button" class="icon-button" aria-label="Close filters" @click="emit('close')"><X :size="20" /></button></header>
			<div class="filter-grid">
				<label class="wide-field">Name<input v-model="localDraft.name" placeholder="Partial title" /></label>
				<label>Release year from<input v-model="localDraft.releaseFrom" type="number" min="1800" max="2200" /></label>
				<label>Release year to<input v-model="localDraft.releaseTo" type="number" min="1800" max="2200" /></label>
				<label>Added from<input v-model="localDraft.addedFrom" type="date" /></label>
				<label>Added to<input v-model="localDraft.addedTo" type="date" /></label>
				<label>Actor<input v-model="localDraft.actor" placeholder="Partial actor name" /></label>
				<label>Director<input v-model="localDraft.director" placeholder="Partial director name" /></label>
			</div>
			<fieldset><legend>Genres</legend><div class="genre-match"><label><input v-model="localDraft.genreMatch" type="radio" value="any" />Match any</label><label><input v-model="localDraft.genreMatch" type="radio" value="all" />Match all</label></div><div class="genre-choices"><label v-for="genre in genres" :key="genre.key"><input v-model="localDraft.genres" type="checkbox" :value="genre.key" />{{ genre.name }} <small>{{ genre.count }}</small></label></div></fieldset>
			<div class="form-actions"><button type="button" class="button ghost" @click="emit('clear')">Clear all</button><button type="button" class="button secondary" @click="emit('close')">Cancel</button><button class="button" type="submit">Apply filters</button></div>
		</form>
	</div>
</template>
