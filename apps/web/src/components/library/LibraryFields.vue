<script setup lang="ts">
import type { LibraryUpdate } from '@moirai/shared';
withDefaults(defineProps<{ creating?: boolean }>(), { creating: false });
const form = defineModel<LibraryUpdate>('form', { required: true });
</script>
<template>
	<div class="form-grid library-settings-fields">
		<label><span>Name</span><input v-model="form.name" required maxlength="120" autocapitalize="words" /></label>
		<label><span>Type</span><select v-model="form.typeKey"><option value="movies">Movies</option><option value="shows">Shows</option><option value="music-videos">Music videos</option><option value="other">Other</option></select></label>
		<label class="span-2"><span>Path Moirai scans</span><input v-model="form.sourceConfig!.scanRoot" required /></label>
		<label class="span-2"><span>Path playback engine sees <small>optional</small></span><input v-model="form.sourceConfig!.playbackRoot" /></label>
		<label><span>Fallback scan, minutes</span><input v-model.number="form.scanIntervalMinutes" type="number" inputmode="numeric" min="1" max="10080" required /><small>Used when live watching is unavailable.</small></label>
		<div class="library-settings-checks"><label class="check"><input v-model="form.watcherEnabled" type="checkbox" /> Watch for changes</label><label v-if="!creating" class="check"><input v-model="form.enabled" type="checkbox" /> Enabled for scheduling</label></div>
	</div>
</template>
