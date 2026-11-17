<script setup lang="ts">
import { MAX_MEDIA_SERVER_PATH_REPLACEMENTS, type MediaServerPathReplacement } from '@moirai/shared';
import TwoStepActionButton from '../TwoStepActionButton.vue';
defineProps<{ disabled?: boolean }>();
const mappings = defineModel<MediaServerPathReplacement[]>({ required: true });
</script>
<template>
	<div class="library-path-replacements span-2">
		<div class="card-title-row"><h4>Local folders <small>optional</small></h4><button class="button secondary" type="button" :disabled="disabled || mappings.length >= MAX_MEDIA_SERVER_PATH_REPLACEMENTS" @click="mappings.push({ remotePrefix: '', localPrefix: '' })">Add folder mapping</button></div>
		<p class="source-editor-hint">Map a remote folder to a local folder for direct file playback. Mappings apply to every library using this server.</p>
		<div v-for="(row, index) in mappings" :key="index" class="library-path-replacement">
			<label><span>Remote folder</span><input v-model="row.remotePrefix" :disabled="disabled" autocapitalize="off" placeholder="/data/media" /></label>
			<label><span>Local folder</span><input v-model="row.localPrefix" :disabled="disabled" autocapitalize="off" placeholder="/media" /></label>
			<TwoStepActionButton label="Remove mapping" confirm-label="Remove this mapping" confirm-text="Remove" :disabled="disabled" @confirm="mappings.splice(index, 1)" />
		</div>
	</div>
</template>
