<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { FileText } from '@lucide/vue';
import type { CreditTemplate, SubtitlePreferences } from '@moirai/shared';
import { api } from '../api';
import { errorMessage } from '../error-message';
import LoadingState from './LoadingState.vue';
import FormDisclosure from './FormDisclosure.vue';

const props = defineProps<{ inherit?: boolean; mode?: string | undefined }>();
const model = defineModel<SubtitlePreferences | undefined>();
const emit = defineEmits<{ 'validation-change': [invalid: boolean] }>();
const templates = ref<CreditTemplate[]>([]);
const loaded = ref(false);
const error = ref('');
const pendingOn = computed(() => model.value?.creditsTemplateId === '');
const rememberedTemplate = ref(model.value?.creditsTemplateId ?? '');
const selection = computed({
	get: () => typeof model.value?.creditsTemplateId === 'string' ? 'on' : model.value?.creditsTemplateId === null || !props.inherit ? 'off' : 'inherit',
	set: setSelection,
});
const enabled = computed({ get: () => selection.value === 'on', set: (value: boolean) => setSelection(value ? 'on' : 'off') });
const template = computed({
	get: () => model.value?.creditsTemplateId ?? '',
	set: (value: string) => {
		rememberedTemplate.value = value;
		update(value);
	},
});
watch(() => model.value?.creditsTemplateId, () => {
	if (model.value?.creditsTemplateId) {
		rememberedTemplate.value = model.value.creditsTemplateId;
	}
});
watch(pendingOn, value => emit('validation-change', value), { immediate: true });

/** Preserve other subtitle preferences while writing the existing credits contract. */
function update(value: string | null | undefined): void {
	const next: SubtitlePreferences = { ...model.value, creditsTemplateId: value };
	if (value === undefined) {
		delete next.creditsTemplateId;
	}
	model.value = next;
}

/** Require a template for On and keep inheritance distinct from explicit Off. */
function setSelection(value: string): void {
	if (value === 'on') {
		update(rememberedTemplate.value);
	}
	else {
		update(value === 'inherit' || !props.inherit ? undefined : null);
	}
}

/** Load template choices without showing an empty collection before success. */
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
</script>

<template>
	<FormDisclosure :open="enabled" class="subtitle-credits-option">
		<template #header="{ contentId }">
			<div class="subtitle-credits-row form-disclosure-trigger">
				<span class="form-disclosure-icon" aria-hidden="true"><FileText :size="26" /></span>
				<span class="form-disclosure-copy"><strong>Music video credits</strong><small>Credits for music videos</small></span>
				<label v-if="inherit"><span class="visually-hidden">Music video credits</span><select v-model="selection" aria-label="Music video credits"><option value="inherit">Inherit</option><option value="off">Off</option><option value="on">On</option></select></label>
				<button v-else class="channel-enabled-toggle" type="button" role="switch" aria-label="Music video credits" :aria-checked="enabled" :aria-controls="contentId" @click="enabled = !enabled"><span>{{ enabled ? 'On' : 'Off' }}</span><span class="channel-enabled-track" aria-hidden="true" /></button>
			</div>
		</template>
		<div class="subtitle-credits-settings">
			<p class="field-help">Replace subtitles on music videos. Uses Burn for the whole channel.</p>
			<label><span>Credit template</span><select v-model="template" :disabled="!loaded" :aria-invalid="pendingOn">
				<option disabled value="">Choose a template</option>
				<option v-if="template && !templates.some(item => item.id === template)" :value="template">{{ loaded ? 'Selected template (unavailable)' : 'Selected template' }}</option>
				<option v-for="item in templates" :key="item.id" :value="item.id">{{ item.name }}</option>
			</select></label>
			<LoadingState v-if="!loaded && !error" label="Loading credit templates…" />
			<p v-if="error" class="notice error">{{ error }}</p>
			<p v-else-if="loaded && !templates.length" class="notice">Create a credit template to enable music video credits.</p>
			<p v-else-if="pendingOn && loaded" class="field-error">Choose a credit template to enable credits.</p>
			<p v-if="template && mode === 'convert'" class="notice">Burn mode is used while credits are enabled. Your Convert setting is retained.</p>
		</div>
	</FormDisclosure>
</template>
