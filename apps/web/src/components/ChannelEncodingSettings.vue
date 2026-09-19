<script setup lang="ts">
import { ref, watch } from 'vue';
import { useDisclosureState } from '../disclosure-state';
import { ChevronDown, SlidersHorizontal } from '@lucide/vue';
import type { ChannelCreate } from '@moirai/shared';
import EncodingSettingsEditor from './EncodingSettingsEditor.vue';
import FormDisclosure from './FormDisclosure.vue';

const props = defineProps<{ creating?: boolean; profileId?: string | null | undefined; accelerationPredictionText?: string; accelerationDetail?: string | undefined }>();
const emit = defineEmits<{ 'validation-change': [invalid: boolean] }>();
const audio = defineModel<ChannelCreate['audio']>('audio', { required: true });
const video = defineModel<ChannelCreate['video']>('video', { required: true });
const expanded = props.creating ? ref(false) : useDisclosureState('channel-encoding', !props.profileId);
watch(() => props.profileId, () => {
	if (!props.profileId) {
		expanded.value = true;
	}
});
</script>

<template>
	<FormDisclosure v-model:open="expanded" class="channel-encoding-disclosure">
		<template #summary>
			<span class="encoding-disclosure-chevron" aria-hidden="true"><ChevronDown :size="22" /></span>
			<SlidersHorizontal class="encoding-disclosure-icon" :size="22" aria-hidden="true" />
			<span class="encoding-disclosure-copy"><strong>Video &amp; audio settings</strong><small>{{ profileId ? 'Read-only settings from the selected encoding profile' : 'Custom settings for this channel (overrides default profile)' }}</small></span>
			<span class="encoding-disclosure-badges"><span>{{ profileId ? 'Linked profile' : 'Custom' }}</span><span v-if="video.format">{{ video.format === 'h264' ? 'H.264' : video.format.toUpperCase() }}</span><span v-if="video.width && video.height">{{ video.width }} × {{ video.height }}</span><span v-if="audio.format">{{ audio.format.toUpperCase() }}</span><span v-if="audio.bitrateKbps">{{ audio.bitrateKbps }} kbps</span></span>
		</template>
		<EncodingSettingsEditor v-model:audio="audio" v-model:video="video" show-descriptions :disabled="Boolean(profileId)" :acceleration-prediction-text="accelerationPredictionText ?? ''" :acceleration-detail="accelerationDetail" @validation-change="emit('validation-change', $event)" />
	</FormDisclosure>
</template>
