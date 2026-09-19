<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { FileCode } from '@lucide/vue';
import type { GuideTemplate } from '@moirai/shared';
import { api } from '../api';
import { errorMessage } from '../error-message';
import LoadingState from './LoadingState.vue';

const model = defineModel<string | null | undefined>();
const templates = ref<GuideTemplate[]>([]);
const loaded = ref(false);
const error = ref('');
const defaultName = computed(() => templates.value.find((entry) => entry.isDefault)?.name ?? 'Standard XMLTV');

/** Load available templates before offering an empty assignment list. */
async function load(): Promise<void> {
	error.value = '';
	try {
		templates.value = await api.guideTemplates();
		loaded.value = true;
	}
	catch (cause) {
		error.value = errorMessage(cause);
	}
}

/** Store an explicit assignment, or null to inherit the XMLTV default. */
function select(event: Event): void {
	model.value = (event.target as HTMLSelectElement).value || null;
}

onMounted(load);
</script>

<template>
	<fieldset class="guide-template-selector">
		<legend>Guide template</legend>
		<LoadingState v-if="!loaded && !error" label="Loading guide templates…" />
		<p v-if="error" class="notice error">{{ error }} <button class="button secondary" type="button" @click="load">Retry</button></p>
		<div class="guide-template-selector-row">
			<label>
				<span>XMLTV layout</span>
				<select :value="model ?? ''" :disabled="!loaded" @change="select">
					<option value="">Default ({{ defaultName }})</option>
					<option v-if="model && !templates.some((entry) => entry.id === model)" :value="model">Selected template unavailable</option>
					<option v-for="template in templates" :key="template.id" :value="template.id">{{ template.name }}{{ template.isDefault ? ' (default)' : '' }}</option>
				</select>
			</label>
			<RouterLink class="button secondary contextual" to="/playback/guide-templates"><FileCode :size="19" aria-hidden="true" />Manage Guide Templates</RouterLink>
		</div>
		<p>Unset channels use the default XMLTV template. Changing the default updates those channels’ published guide.</p>
	</fieldset>
</template>
