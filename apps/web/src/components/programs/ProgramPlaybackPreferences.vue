<script setup lang="ts">
import { ChevronDown } from '@lucide/vue';
import type { AudioPreferences, SubtitlePreferences } from '@moirai/shared';
import FormDisclosure from '../FormDisclosure.vue';
import AudioPreferencesEditor from '../AudioPreferencesEditor.vue';
import SubtitlePreferencesEditor from '../SubtitlePreferencesEditor.vue';

defineProps<{ step: number; resetRevision?: number | undefined; programId?: string | null | undefined }>();
const open = defineModel<boolean>('open', { required: true });
const audio = defineModel<AudioPreferences | undefined>('audio');
const subtitles = defineModel<SubtitlePreferences | undefined>('subtitles');
const emit = defineEmits<{ 'validation-change': [invalid: boolean] }>();
</script>

<template>
	<FormDisclosure v-model:open="open" class="program-subtitle-disclosure">
		<template #summary>
			<div class="program-section-heading">
				<span>{{ step }}</span>
				<div class="program-section-heading-copy">
					<strong>Audio and subtitles — optional</strong>
					<p class="program-section-description">Override inherited audio and subtitle settings for this program.</p>
				</div>
			</div>
			<ChevronDown class="form-disclosure-chevron" :size="22" aria-hidden="true" />
		</template>
		<AudioPreferencesEditor v-model="audio" inherit unframed />
		<SubtitlePreferencesEditor v-model="subtitles" :program-id="programId" :reset-revision="resetRevision" inherit unframed @validation-change="emit('validation-change', $event)" />
	</FormDisclosure>
</template>
