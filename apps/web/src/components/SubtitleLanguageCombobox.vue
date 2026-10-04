<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue';
import { loadSubtitleLanguages, resolveSubtitleLanguage, searchSubtitleLanguages, type SubtitleLanguage } from '../subtitle-languages';
import { errorMessage } from '../error-message';
import LoadingState from './LoadingState.vue';

const props = defineProps<{ disabled?: boolean }>();
const model = defineModel<string>({ required: true });
const emit = defineEmits<{ 'validation-change': [invalid: boolean] }>();
const id = useId();
const query = ref(model.value);
const lastEmitted = ref(model.value);
const savedCode = ref<string | undefined>(model.value);
const languages = ref<SubtitleLanguage[]>([]);
const loaded = ref(false);
const error = ref('');
const open = ref(false);
const active = ref(-1);
const list = ref<HTMLElement>();
let disposed = false;
onBeforeUnmount(() => {
	disposed = true;
});
const results = computed(() => searchSubtitleLanguages(languages.value, query.value));
const resolved = computed(() => resolveSubtitleLanguage(query.value, languages.value, savedCode.value !== undefined && query.value === savedCode.value));
// Untouched saved aliases remain usable; edited text must pass name/code collision checks.
const pendingValidation = computed(() => !loaded.value && !error.value
	&& !(savedCode.value !== undefined && query.value === savedCode.value));
const invalid = computed(() => pendingValidation.value || resolved.value === null);
watch(invalid, value => emit('validation-change', value), { immediate: true });
watch([open, loaded], async ([expanded]) => {
	if (expanded) {
		await nextTick();
		list.value?.scrollIntoView({ block: 'nearest' });
	}
});
watch(active, async value => {
	await nextTick();
	list.value?.children[value]?.scrollIntoView({ block: 'nearest' });
});
watch(model, value => {
	if (value !== lastEmitted.value) {
		query.value = value;
		savedCode.value = value;
		lastEmitted.value = value;
	}
});
watch(() => props.disabled, disabled => {
	if (disabled) {
		open.value = false;
	}
});

/** Keep incomplete search text in the draft so dirty-state and save validation remain accurate. */
function commit(): void {
	lastEmitted.value = resolved.value ?? query.value.trim().toLowerCase();
	model.value = lastEmitted.value;
}

/** Validate edits once names load, ignoring removed controls; load failure permits code entry. */
async function load(): Promise<void> {
	try {
		const inventory = await loadSubtitleLanguages();
		if (disposed) {
			return;
		}
		languages.value = inventory;
		loaded.value = true;
		commit();
	}
	catch (cause) {
		if (!disposed) {
			error.value = errorMessage(cause);
		}
	}
}
onMounted(load);

/** Search without replacing the text being typed with a formatted option label. */
function input(event: Event): void {
	savedCode.value = undefined;
	query.value = (event.target as HTMLInputElement).value;
	active.value = -1;
	open.value = true;
	commit();
}

/** Commit a named choice using its preferred code and retain input focus. */
function choose(language: SubtitleLanguage): void {
	query.value = `${language.name} (${language.code})`;
	commit();
	open.value = false;
	active.value = -1;
}

/** Support native combobox keys without allowing a popup action to submit or close the editor. */
function keydown(event: KeyboardEvent): void {
	if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
		event.preventDefault();
		open.value = true;
		const direction = event.key === 'ArrowDown' ? 1 : -1;
		const count = results.value.length;
		active.value = count ? active.value < 0 ? (direction > 0 ? 0 : count - 1) : (active.value + direction + count) % count : -1;
	}
	else if (event.key === 'Escape' && open.value) {
		event.preventDefault();
		event.stopPropagation();
		open.value = false;
	}
	else if (event.key === 'Enter' && open.value) {
		event.preventDefault();
		if (active.value >= 0 && results.value[active.value]) {
			choose(results.value[active.value]!);
		}
		else {
			open.value = false;
		}
	}
}
</script>

<template>
	<div class="subtitle-language-combobox" @focusout="open = false">
		<label :for="id">Specific subtitle language</label>
		<input :id="id" :value="query" role="combobox" autocomplete="off" aria-autocomplete="list" :aria-expanded="open && loaded" :aria-controls="`${id}-options`" :aria-activedescendant="open && active >= 0 ? `${id}-option-${active}` : undefined" :aria-invalid="invalid" :aria-describedby="`${id}-help`" :disabled="disabled" placeholder="Search a language name or code" @focus="open = true" @input="input" @keydown="keydown" />
		<div v-if="open && loaded" :id="`${id}-options`" ref="list" role="listbox" aria-label="Subtitle languages" class="subtitle-language-options">
			<button v-for="(language, index) in results" :id="`${id}-option-${index}`" :key="language.code" type="button" role="option" tabindex="-1" :aria-selected="index === active" @pointerdown.prevent @click="choose(language)">{{ language.name }} ({{ language.code }})</button>
			<p v-if="!results.length">No named language matches. You can enter a two- or three-letter code.</p>
		</div>
		<small :id="`${id}-help`" :class="{ 'field-error': invalid && !pendingValidation }">{{ pendingValidation ? 'Waiting for language names before validating this entry.' : invalid ? 'Choose a language from the list if its name also matches a code; otherwise enter a language name or code.' : 'Names and equivalent codes match the same language. Your saved code is preserved.' }}</small>
		<LoadingState v-if="!loaded && !error" label="Loading language names…" />
		<p v-if="error" class="notice error">Language names could not load: {{ error }}. You can still enter a language code.</p>
	</div>
</template>
