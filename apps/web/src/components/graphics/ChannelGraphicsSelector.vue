<script setup lang="ts">
import { ChevronDown, Layers } from '@lucide/vue';
import { ref, watch } from 'vue';
import type { GraphicsPreset } from '@moirai/shared';
import { api } from '../../api';
import { errorMessage } from '../../error-message';
import { useDisclosureState } from '../../disclosure-state';
import FormDisclosure from '../FormDisclosure.vue';

const model = defineModel<string | null | undefined>();
const props = defineProps<{ channelId?: string | null }>();
const expanded = useDisclosureState('channel-graphics', false);
const presets = ref<GraphicsPreset[]>([]);
const status = ref<'loading' | 'loaded' | 'failed'>('loading');
const error = ref('');
const issue = ref('');
const warningError = ref('');
let revision = 0;

/** Load warning state without changing whether the preset selector can be used. */
async function loadWarning(id: string, current: number): Promise<void> {
	try {
		const warning = await api.channelGraphicsIssue(id);
		if (current === revision) {
			issue.value = warning.issue ?? '';
		}
	}
	catch {
		if (current === revision) {
			warningError.value = 'Graphics preparation status is unavailable.';
		}
	}
}

/** Load assignable presets, keeping a failed request distinct from an empty assignment. */
async function load(): Promise<void> {
	const current = ++revision;
	const id = props.channelId;
	status.value = 'loading';
	presets.value = [];
	error.value = '';
	issue.value = '';
	warningError.value = '';
	if (id) {
		void loadWarning(id, current);
	}
	try {
		const entries = await api.graphicsPresets();
		if (current === revision) {
			presets.value = entries;
			status.value = 'loaded';
		}
	}
	catch (cause) {
		if (current === revision) {
			status.value = 'failed';
			error.value = errorMessage(cause);
		}
	}
}

watch(() => props.channelId, load, { immediate: true });
</script>

<template>
	<FormDisclosure v-model:open="expanded" class="channel-graphics-disclosure">
		<template #summary>
			<span class="form-disclosure-icon" aria-hidden="true"><Layers :size="26" /></span>
			<span class="form-disclosure-copy"><strong>On-screen graphics</strong><small>Show watermarks and programme overlays on this channel</small></span>
			<ChevronDown class="form-disclosure-chevron" :size="22" aria-hidden="true" />
		</template>
		<div class="channel-graphics-selector">
			<div class="channel-graphics-selector-row">
				<label><span>Graphics preset</span>
					<select :disabled="status !== 'loaded'" :value="status === 'loaded' ? model ?? '' : ''" @change="model = ($event.target as HTMLSelectElement).value || null">
						<option value="">{{ status === 'loading' ? 'Loading graphics presets…' : status === 'failed' ? 'Graphics presets unavailable' : 'No graphics' }}</option>
						<option v-if="status === 'loaded' && model && !presets.some(preset => preset.id === model)" :value="model">Selected preset unavailable</option>
						<option v-for="preset in presets" :key="preset.id" :value="preset.id">{{ preset.name }}</option>
					</select>
				</label>
				<RouterLink class="button secondary contextual" to="/graphics"><Layers :size="19" aria-hidden="true" />Manage Graphics</RouterLink>
			</div>
		</div>
	</FormDisclosure>
	<p v-if="error" class="notice error" role="alert">{{ error }} <button class="button secondary" type="button" @click="load">Retry</button></p>
	<p v-if="warningError" class="notice warning" role="status">{{ warningError }}</p>
	<p v-if="issue" class="notice warning" role="status">{{ issue }}</p>
</template>
