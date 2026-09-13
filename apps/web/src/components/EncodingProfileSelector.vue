<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { Settings } from '@lucide/vue';
import type { ChannelCreate, EncodingProfile } from '@moirai/shared';
import { api } from '../api';
import { cloneContractValue } from '../reactive-clone';
import { errorMessage } from '../error-message';
import LoadingState from './LoadingState.vue';

const props = defineProps<{ useDefault?: boolean }>();
const emit = defineEmits<{ ready: [value: boolean] }>();
const model = defineModel<string | null | undefined>();
const audio = defineModel<ChannelCreate['audio']>('audio', { required: true });
const video = defineModel<ChannelCreate['video']>('video', { required: true });
const profiles = ref<EncodingProfile[]>([]);
const loaded = ref(false);
const error = ref('');

/** Load available profiles before offering an empty profile collection. */
async function load(): Promise<void> {
	error.value = '';
	try {
		profiles.value = await api.encodingProfiles();
		loaded.value = true;
		if (props.useDefault) {
			const profile = profiles.value.find((entry) => entry.isDefault);
			if (profile) {
				audio.value = cloneContractValue(profile.audio);
				video.value = cloneContractValue(profile.video);
				model.value = profile.id;
			}
		}
		emit('ready', true);
	}
	catch (cause) {
		error.value = errorMessage(cause);
	}
}

/** Copy effective values into the draft; Custom detaches without discarding those values. */
function select(event: Event): void {
	const id = (event.target as HTMLSelectElement).value;
	const profile = profiles.value.find((entry) => entry.id === (id || model.value));
	if (profile) {
		audio.value = cloneContractValue(profile.audio);
		video.value = cloneContractValue(profile.video);
	}
	model.value = id || null;
}
onMounted(load);
</script>

<template>
	<fieldset>
		<legend>Encoding profile</legend>
		<LoadingState v-if="!loaded && !error" label="Loading encoding profiles…" />
		<p v-if="error" class="notice error">{{ error }} <button class="button secondary" type="button" @click="load">Retry</button></p>
		<div class="encoding-profile-selector-row"><label><span>Audio and video settings</span><select :value="model ?? ''" :disabled="!loaded" @change="select"><option value="">Custom</option><option v-if="model && !profiles.some((profile) => profile.id === model)" :value="model">Selected profile unavailable</option><option v-for="profile in profiles" :key="profile.id" :value="profile.id">{{ profile.name }}{{ profile.isDefault ? ' (default)' : '' }}</option></select></label><RouterLink class="button secondary contextual" to="/playback/encoding-profiles"><Settings :size="19" aria-hidden="true" />Manage Encoding Profiles</RouterLink></div>
		<slot />
	</fieldset>
</template>
