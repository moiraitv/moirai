<script setup lang="ts">
import { useDisclosureState } from '../disclosure-state';
import { computed, onMounted, ref, watch } from 'vue';
import { Captions, ChevronDown, ExternalLink, Info } from '@lucide/vue';
import FormDisclosure from './FormDisclosure.vue';
import type { CreditTemplate, SubtitlePreferences } from '@moirai/shared';
import { api } from '../api';
import { errorMessage } from '../error-message';
import LoadingState from './LoadingState.vue';

const props = defineProps<{ inherit?: boolean; unframed?: boolean; channelLayout?: boolean; channelId?: string | undefined; mode?: string }>();
const model = defineModel<SubtitlePreferences | undefined>();
const templates = ref<CreditTemplate[]>([]);
const loaded = ref(false);
const error = ref('');
const issues = ref<string[]>([]);
const additionalOpen = useDisclosureState('channel-subtitles', true);
const policy = computed({
	get: () => model.value?.policy ?? '',
	set: (value: string) => update('policy', value || undefined),
});
const language = computed({
	get: () => model.value?.language === null ? '*' : model.value?.language ?? '',
	set: (value: string) => update('language', value === '*' ? null : value.trim().toLowerCase() || undefined),
});
const credits = computed({
	get: () => model.value?.creditsTemplateId === null ? '-' : model.value?.creditsTemplateId ?? '',
	set: (value: string) => update('creditsTemplateId', value === '-' ? null : value || undefined),
});

/** Preserve untouched preference fields and remove explicit inheritance keys. */
function update(key: keyof SubtitlePreferences, value: string | null | undefined): void {
	const next = { ...model.value, [key]: value };
	if (value === undefined) {
		delete next[key];
	}
	model.value = next as SubtitlePreferences;
}

/** Load selectable templates before showing an empty collection state. */
async function load(): Promise<void> {
	try {
		templates.value = await api.creditTemplates();
		loaded.value = true;
	}
	catch (cause) {
		error.value = errorMessage(cause);
	}
}
onMounted(load);
watch(() => props.channelId, async (id) => {
	issues.value = [];
	if (id) {
		try {
			issues.value = await api.subtitleIssues(id);
		}
		catch (cause) {
			error.value = errorMessage(cause);
		}
	}
}, { immediate: true });
</script>

<template>
	<component :is="unframed ? 'div' : 'fieldset'" class="subtitle-preferences" :class="{ 'channel-subtitles': channelLayout }">
		<legend v-if="!unframed">{{ channelLayout ? 'Subtitles' : 'Subtitles and music-video credits' }}</legend>
		<div class="form-grid" :class="channelLayout ? 'subtitle-selection-fields' : 'three'">
			<label><span>Subtitle selection</span><select v-model="policy">
				<option value="">{{ inherit ? 'Inherit' : 'Off' }}</option>
				<option v-if="inherit" value="off">Off</option>
				<option value="forced">Forced only</option><option value="default">Prefer default</option><option value="any">Any matching track</option>
			</select></label>
			<label><span>Preferred language code</span><input v-model="language" :placeholder="inherit ? 'Inherit (use * for any)' : 'Any language'" pattern="[A-Za-z]{2,3}|\*" maxlength="3" />
				<small>Two or three letters, such as en or eng.</small></label>
			<div v-if="!channelLayout">
				<label><span>Music-video credits</span><select v-model="credits" :disabled="!loaded">
					<option value="">{{ inherit ? 'Inherit' : 'Off' }}</option><option v-if="inherit" value="-">Off</option>
					<option v-for="template in templates" :key="template.id" :value="template.id">{{ template.name }}</option>
				</select></label>
				<p class="subtitle-credits-hint"><Info :size="20" aria-hidden="true" /><span>Music-video credits replace ordinary subtitles for music videos and automatically use Burn mode for the whole channel.</span></p>
				<RouterLink class="subtitle-manage-link" to="/playback/credit-templates">Manage credit templates<ExternalLink :size="16" aria-hidden="true" /></RouterLink>
			</div>
		</div>
		<FormDisclosure v-if="channelLayout" v-model:open="additionalOpen" class="subtitle-additional-settings">
			<template #summary>
				<span class="form-disclosure-icon" aria-hidden="true"><Captions :size="26" /></span>
				<span class="form-disclosure-copy"><strong>Additional subtitle settings</strong><small>Music-video credits, subtitle mode, fonts, and more</small></span>
				<ChevronDown class="form-disclosure-chevron" :size="22" aria-hidden="true" />
			</template>
			<div class="subtitle-additional-fields">
				<div><label><span>Music-video credits</span><select v-model="credits" :disabled="!loaded">
						<option value="">Off</option><option v-for="template in templates" :key="template.id" :value="template.id">{{ template.name }}</option>
					</select></label>
					<p class="subtitle-credits-hint"><Info :size="20" aria-hidden="true" /><span>Music-video credits replace ordinary subtitles for music videos and automatically use Burn mode for the whole channel.</span></p>
					<RouterLink class="subtitle-manage-link" to="/playback/credit-templates">Manage credit templates<ExternalLink :size="16" aria-hidden="true" /></RouterLink></div>
				<slot />
			</div>
		</FormDisclosure>
		<LoadingState v-if="!loaded && !error" label="Loading credit templates…" />
		<p v-if="error" class="notice error">{{ error }}</p>
		<p v-if="credits && credits !== '-' && mode === 'convert'" class="notice">Burn mode is used while credits are enabled. Your Convert setting is retained.</p>
		<p v-for="issue in issues" :key="issue" class="notice error">{{ issue }}</p>
		<slot v-if="!channelLayout" />
	</component>
</template>
