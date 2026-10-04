<script setup lang="ts">
import { useDisclosureState } from '../disclosure-state';
import { computed, ref, useId, watch } from 'vue';
import { Captions, ChevronDown, Info, ListFilter, ListOrdered, Ban, ShieldCheck, Settings2 } from '@lucide/vue';
import FormDisclosure from './FormDisclosure.vue';
import SubtitleSelectionPreview from './SubtitleSelectionPreview.vue';
import SubtitleLanguageCombobox from './SubtitleLanguageCombobox.vue';
import type { SubtitlePreferences } from '@moirai/shared';
import { subtitleRuleMode, type SubtitleRuleMode } from '../subtitle-preferences';
import { api } from '../api';
import { errorMessage } from '../error-message';
import SubtitleCreditsOption from './SubtitleCreditsOption.vue';

const props = defineProps<{ resetRevision?: number | undefined; inherit?: boolean; unframed?: boolean; channelLayout?: boolean; channelId?: string | undefined; mode?: string; programId?: string | null | undefined }>();
const model = defineModel<SubtitlePreferences | undefined>();
const emit = defineEmits<{ 'validation-change': [invalid: boolean] }>();
const id = useId();
const error = ref('');
const issues = ref<string[]>([]);
const languageInvalid = ref(false);
const creditsInvalid = ref(false);
const additionalOpen = props.channelLayout && !props.channelId ? ref(false) : useDisclosureState('channel-subtitles', true);
const policy = computed({
	get: () => model.value?.policy ?? (props.inherit ? '' : 'off'),
	set: (value: string) => {
		const next = { ...model.value };
		if (value === 'off') {
			// Discard incomplete rules so hidden controls cannot block saving Off.
			if (languageInvalid.value || (typeof next.language === 'string' && !/^[a-z]{2,3}$/.test(next.language))) {
				next.language = null;
			}
			languageInvalid.value = false;
			if (titleInvalid.value) {
				next.title = null;
			}
		}
		if (value) {
			next.policy = value as SubtitlePreferences['policy'];
		}
		else {
			delete next.policy;
		}
		model.value = next;
	},
});
const policies = computed(() => [
	...(props.inherit ? [{ value: '', label: 'Inherit selection', detail: 'Enclosing program or channel', icon: ListOrdered }] : []),
	{ value: 'off', label: 'Off', detail: 'No ordinary subtitles', icon: Ban },
	{ value: 'default', label: 'Prefer default', detail: 'Prefer an eligible default track', icon: Captions },
	{ value: 'any', label: 'Any matching track', detail: 'Use your language and title rules', icon: ListFilter },
	{ value: 'forced', label: 'Forced only', detail: 'Require the file’s forced flag', icon: ShieldCheck },
]);
const languageMode = computed({
	get: () => subtitleRuleMode(model.value?.language, Boolean(props.inherit)),
	set: (value: SubtitleRuleMode) => setRuleMode('language', value),
});
const titleMode = computed({
	get: () => subtitleRuleMode(model.value?.title, Boolean(props.inherit)),
	set: (value: SubtitleRuleMode) => setRuleMode('title', value),
});
const language = computed({ get: () => model.value?.language ?? '', set: (value: string) => update('language', value) });
const title = computed({ get: () => model.value?.title ?? '', set: (value: string) => update('title', value) });
const titleInvalid = computed(() => titleMode.value === 'specific' && (!title.value.trim() || title.value.trim().length > 200));
const invalid = computed(() => Boolean(creditsInvalid.value || titleInvalid.value || (languageMode.value === 'specific' && (languageInvalid.value || !/^[a-z]{2,3}$/.test(language.value)))));
watch(invalid, value => emit('validation-change', value), { immediate: true });

/** Preserve untouched preference fields and remove explicit inheritance keys. */
function update(key: keyof SubtitlePreferences, value: string | null | undefined): void {
	const next = { ...model.value, [key]: value };
	if (value === undefined) {
		delete next[key];
	}
	model.value = next as SubtitlePreferences;
}

/** Express inheritance and clearing through existing fields; empty specific drafts require completion. */
function setRuleMode(key: 'language' | 'title', mode: SubtitleRuleMode): void {
	if (key === 'language') {
		languageInvalid.value = false;
	}
	update(key, mode === 'inherit' ? undefined : mode === 'any' ? null : '');
}

watch(() => props.channelId, async (channelId) => {
	issues.value = [];
	if (channelId) {
		try {
			issues.value = await api.subtitleIssues(channelId);
		}
		catch (cause) {
			error.value = errorMessage(cause);
		}
	}
}, { immediate: true });
</script>

<template>
	<component :is="unframed ? 'div' : 'fieldset'" class="subtitle-preferences" :class="{ 'channel-subtitles': channelLayout }">
		<legend v-if="!unframed">{{ channelLayout ? 'Subtitles' : 'Subtitles and music video credits' }}</legend>
		<div class="subtitle-policy-grid" role="radiogroup" aria-label="Subtitle behavior">
			<label v-for="option in policies" :key="option.value" class="subtitle-policy-card" :class="{ active: policy === option.value }">
				<input v-model="policy" type="radio" :name="`${id}-policy`" :value="option.value" :aria-label="option.label" />
				<component :is="option.icon" :size="20" aria-hidden="true" />
				<span><strong>{{ option.label }}</strong><small>{{ option.detail }}</small></span>
			</label>
		</div>
		<section v-show="policy !== 'off'" class="subtitle-selection-rules" :aria-labelledby="`${id}-rules`">
			<h3 :id="`${id}-rules`"><ListFilter :size="20" aria-hidden="true" />Selection rules</h3>
			<div class="form-grid two">
				<div class="subtitle-rule">
					<label><span>Subtitle language</span><select v-model="languageMode" :disabled="policy === 'off'">
						<option v-if="inherit" value="inherit">Inherit language</option><option value="any">Any language</option><option value="specific">Specific language</option>
					</select></label>
					<SubtitleLanguageCombobox v-if="languageMode === 'specific'" :key="resetRevision ?? 0" v-model="language" :disabled="policy === 'off'" @validation-change="languageInvalid = $event" />
				</div>
				<div class="subtitle-rule">
					<label><span>Subtitle title rule</span><select v-model="titleMode" :disabled="policy === 'off'">
						<option v-if="inherit" value="inherit">Inherit title rule</option><option value="any">Any title</option><option value="specific">Specific title</option>
					</select></label>
					<label v-if="titleMode === 'specific'"><span>Subtitle title contains</span><input v-model="title" aria-label="Subtitle title contains" maxlength="200" :disabled="policy === 'off'" :aria-invalid="Boolean(titleInvalid)" :aria-describedby="`${id}-title-help`" placeholder="For example, Signs or Forced" />
						<small :id="`${id}-title-help`" :class="{ 'field-error': titleInvalid }">{{ titleInvalid ? 'Enter 1–200 characters, or choose Any title.' : 'Matches part of the recorded title, ignoring case. Not a regular expression.' }}</small>
					</label>
				</div>
			</div>
			<p class="field-help">Language, title, and policy must all match. A track titled “Forced” still needs the forced flag for Forced only; choose Any matching track to select it by title alone.</p>
		</section>
		<FormDisclosure v-if="channelLayout" v-model:open="additionalOpen" class="subtitle-additional-settings">
			<template #summary>
				<span class="form-disclosure-icon" aria-hidden="true"><Settings2 :size="26" /></span>
				<span class="form-disclosure-copy"><strong>Presentation</strong><small>Subtitle mode and fonts</small></span>
				<ChevronDown class="form-disclosure-chevron" :size="22" aria-hidden="true" />
			</template>
			<div class="subtitle-additional-fields"><slot /></div>
		</FormDisclosure>
		<p v-else class="field-help subtitle-presentation-hint"><Info :size="16" aria-hidden="true" /><span>Subtitle mode and fonts follow the channel’s Presentation settings.</span></p>
		<SubtitleSelectionPreview :preferences="model" :inherit="inherit" :invalid="invalid" :program-id="programId" />
		<SubtitleCreditsOption v-model="model" :inherit="inherit" :mode="mode" @validation-change="creditsInvalid = $event" />
		<p v-if="error" class="notice error">{{ error }}</p>
		<p v-for="issue in issues" :key="issue" class="notice error">{{ issue }}</p>
	</component>
</template>
