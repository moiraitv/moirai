<script setup lang="ts">
import { ChevronDown } from '@lucide/vue';
import { computed, ref } from 'vue';
import type { GraphicsAssignment, GraphicsPreset } from '@moirai/shared';
import { api } from '../../api';
import FormDisclosure from '../FormDisclosure.vue';

defineProps<{ description: string; disabled?: boolean }>();
const model = defineModel<GraphicsAssignment | undefined>();
const open = ref(false);
const presets = ref<GraphicsPreset[] | null>(null);
const loading = ref(false);
const failed = ref(false);
const selectedPreset = computed(() => model.value && 'presetId' in model.value ? model.value.presetId : undefined);

/** Load the shared preset list only when this disclosure is opened. */
async function load(expanded: boolean): Promise<void> {
	if (!expanded || presets.value || loading.value) {
		return;
	}
	loading.value = true;
	failed.value = false;
	try {
		presets.value = await api.graphicsPresets();
	}
	catch {
		failed.value = true;
	}
	finally {
		loading.value = false;
	}
}

/** Change inheritance mode while retaining any already selected preset. */
function changeMode(event: Event): void {
	const mode = (event.target as HTMLSelectElement).value as GraphicsAssignment['mode'];
	if (mode === 'inherit' || mode === 'off') {
		model.value = { mode };
	}
	else {
		const presetId = model.value && 'presetId' in model.value ? model.value.presetId : presets.value?.[0]?.id;
		if (presetId) {
			model.value = { mode, presetId };
		}
	}
}

/** Replace the preset while keeping the selected assignment mode. */
function changePreset(event: Event): void {
	if (model.value && 'presetId' in model.value) {
		model.value = { ...model.value, presetId: (event.target as HTMLSelectElement).value };
	}
}
</script>

<template>
	<FormDisclosure v-model:open="open" class="graphics-assignment" @update:open="load">
		<template #summary>
			<strong>On-screen graphics</strong><ChevronDown class="form-disclosure-chevron" :size="20" aria-hidden="true" />
		</template>
		<div class="graphics-assignment-fields">
			<label>
				<span>Graphics assignment</span>
				<select :value="loading ? 'loading' : model?.mode ?? 'inherit'" :disabled="disabled || (!presets && !failed)" @change="changeMode">
					<option v-if="loading" value="loading">Loading graphics presets…</option>
					<option value="inherit">Inherit</option>
					<option value="add" :disabled="!presets?.length">Add to inherited graphics</option>
					<option value="replace" :disabled="!presets?.length">Replace inherited graphics</option>
					<option value="off">No graphics</option>
				</select>
			</label>
			<label v-if="model && 'presetId' in model">
				<span>Graphics preset</span>
				<select :value="model.presetId" :disabled="disabled || !presets" @change="changePreset">
					<option v-if="!presets?.some(preset => preset.id === selectedPreset)" :value="model.presetId">{{ loading ? 'Loading preset…' : 'Selected preset' }}</option>
					<option v-for="preset in presets ?? []" :key="preset.id" :value="preset.id">{{ preset.name }}</option>
				</select>
			</label>
		</div>
		<p class="field-hint">{{ description }}</p>
		<p v-if="loading" class="sr-only" role="status">Loading graphics presets…</p>
		<p v-else-if="failed" class="notice error" role="alert">Could not load graphics presets. Reopen this section to retry.</p>
	</FormDisclosure>
</template>
