<script setup lang="ts">
import { computed, watch } from 'vue';
import { audioPreferencesSchema, type AudioPreferences } from '@moirai/shared';
import { useFieldValidation } from '../field-validation';

const props = defineProps<{ inherit?: boolean; unframed?: boolean; disabled?: boolean; resetRevision?: number }>();
const model = defineModel<AudioPreferences | undefined>();
const validation = useFieldValidation(() => audioPreferencesSchema.safeParse(model.value ?? {}));
watch(() => props.resetRevision, () => validation.reset());
const language = computed({
	get: () => model.value?.language === null ? '*' : model.value?.language ?? '',
	set: (value: string) => update('language', value.toLowerCase()),
});
const title = computed({
	get: () => model.value?.title === null ? '*' : model.value?.title ?? '',
	set: (value: string) => update('title', value),
});

/** Keep inheritance distinct from explicitly clearing a preference. */
function update(key: keyof AudioPreferences, value: string): void {
	const next = { ...model.value };
	const trimmed = value.trim();
	if (!trimmed) {
		delete next[key];
	}
	else {
		next[key] = trimmed === '*' ? null : value;
	}
	model.value = next;
}
</script>

<template>
	<component :is="unframed ? 'div' : 'fieldset'" class="audio-preferences">
		<legend v-if="!unframed">Audio selection</legend>
		<div class="form-grid two">
			<label><span>Preferred language code</span>
				<input v-model="language" :placeholder="inherit ? 'Inherit (use * for any)' : 'Any language'" pattern="[A-Za-z]{2,3}|\*" maxlength="3" :disabled="disabled" v-bind="validation.attributes('language')" />
				<small v-if="validation.error('language')" :id="validation.errorId('language')" class="field-error">{{ validation.error('language') }}</small>
				<small>Two or three letters, such as en or eng.</small>
			</label>
			<label><span>Preferred audio title</span>
				<input v-model="title" :placeholder="inherit ? 'Inherit (use * for any)' : 'Any title'" maxlength="200" :disabled="disabled" v-bind="validation.attributes('title')" />
				<small v-if="validation.error('title')" :id="validation.errorId('title')" class="field-error">{{ validation.error('title') }}</small>
				<small>Matches part of the track title, ignoring case. Not a regular expression.</small>
			</label>
		</div>
		<p class="field-help">If no track matches, playback uses another available audio track.</p>
	</component>
</template>
