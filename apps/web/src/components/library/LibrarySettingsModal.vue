<script setup lang="ts">
import { computed, onMounted, reactive, ref, useTemplateRef, watch } from 'vue';
import { AlertTriangle, ChevronDown, Trash2, X } from '@lucide/vue';
import type { Library, LibraryUpdate } from '@moirai/shared';
import { api } from '../../api';
import { errorMessage } from '../../error-message';
import { useAnimatedDismissal } from '../../motion';
import AnimatedDisclosure from '../AnimatedDisclosure.vue';

const props = defineProps<{ library: Library }>();
const emit = defineEmits<{
	close: [];
	deleted: [];
	saved: [library: Library];
}>();
const nameInput = useTemplateRef<HTMLInputElement>('nameInput');
const saving = ref(false);
const deleting = ref(false);
const error = ref('');
const deleteConfirmation = ref('');
const dangerOpen = ref(false);
const form = reactive<LibraryUpdate>({
	name: props.library.name,
	typeKey: props.library.typeKey,
	sourceType: props.library.sourceType,
	sourceConfig: { ...props.library.sourceConfig },
	scanIntervalMinutes: props.library.scanIntervalMinutes,
	watcherEnabled: props.library.watcherEnabled,
	enabled: props.library.enabled,
});
const deletionConfirmed = computed(() => deleteConfirmation.value === props.library.name);
const { visible, requestClose, finishClose } = useAnimatedDismissal(() => emit('close'));

/** Save the editable library configuration and return the authoritative record. */
async function save(): Promise<void> {
	saving.value = true;
	error.value = '';
	try {
		const library = await api.updateLibrary(props.library.id, {
			...form,
			sourceConfig: form.sourceConfig
				? { ...form.sourceConfig, playbackRoot: form.sourceConfig.playbackRoot || null }
				: undefined,
		});
		emit('saved', library);
	}
	catch (cause) {
		error.value = errorMessage(cause);
	}
	finally {
		saving.value = false;
	}
}

/** Permanently remove the configured library after exact-name confirmation. */
async function remove(): Promise<void> {
	if (!deletionConfirmed.value) {
		return;
	}

	deleting.value = true;
	error.value = '';
	try {
		await api.deleteLibrary(props.library.id);
		emit('deleted');
	}
	catch (cause) {
		error.value = errorMessage(cause);
	}
	finally {
		deleting.value = false;
	}
}

/** Clear destructive confirmation whenever its disclosure is collapsed. */
watch(dangerOpen, (open) => {
	if (!open) {
		deleteConfirmation.value = '';
	}
});

onMounted(() => nameInput.value?.focus());
</script>

<template>
	<Teleport to="body">
		<Transition name="moirai-overlay" appear @after-leave="finishClose">
			<div v-show="visible" class="moirai-dialog-backdrop" :inert="!visible" :aria-hidden="!visible" @click.self="requestClose" @keydown.esc.stop.prevent="requestClose">
				<form
					class="moirai-dialog library-settings-modal"
					role="dialog"
					aria-modal="true"
					aria-labelledby="library-settings-title"
					@submit.prevent="save"
				>
					<header class="modal-heading">
						<div>
							<p class="eyebrow">Library settings</p>
							<h2 id="library-settings-title">Library settings for {{ library.name }}</h2>
						</div>
						<button type="button" class="icon-button" aria-label="Close library settings" @click="requestClose"><X :size="22" /></button>
					</header>

					<div class="form-grid library-settings-fields">
						<label><span>Name</span><input ref="nameInput" v-model="form.name" required maxlength="120" autocapitalize="words" /></label>
						<label><span>Type</span><select v-model="form.typeKey"><option value="movies">Movies</option><option value="shows">Shows</option><option value="music-videos">Music videos</option><option value="other">Other</option></select></label>
						<label class="span-2"><span>Path Moirai scans</span><input v-model="form.sourceConfig!.scanRoot" required /></label>
						<label class="span-2"><span>Path playback engine sees <small>optional</small></span><input v-model="form.sourceConfig!.playbackRoot" /></label>
						<label><span>Fallback scan, minutes</span><input v-model.number="form.scanIntervalMinutes" type="number" min="1" max="10080" required /><small>Used when live watching is unavailable.</small></label>
						<div class="library-settings-checks">
							<label class="check"><input v-model="form.watcherEnabled" type="checkbox" /> Watch for changes</label>
							<label class="check"><input v-model="form.enabled" type="checkbox" /> Enabled for scheduling</label>
						</div>
					</div>

					<p class="library-settings-note">Changing the source path or library identity can require index reconciliation. Run a sync after saving to inspect the new source.</p>
					<p v-if="error" class="notice error">{{ error }}</p>
					<div class="form-actions"><button type="button" class="button ghost" @click="requestClose">Cancel</button><button class="button" :disabled="saving || deleting">{{ saving ? 'Saving…' : 'Save Settings' }}</button></div>

					<AnimatedDisclosure v-model="dangerOpen" class="library-danger-zone">
						<template #summary><span class="library-danger-heading"><AlertTriangle :size="24" /><h3 id="library-delete-title">Permanently remove this library</h3><ChevronDown class="library-danger-chevron" :size="18" /></span></template>
						<div class="library-danger-content" aria-labelledby="library-delete-title">
							<p><strong>This action cannot be undone.</strong> It deletes the library configuration, index, and cached artwork from Moirai. Your source media files will not be changed.</p>
							<label><span>Type <strong>{{ library.name }}</strong> to confirm</span><input v-model="deleteConfirmation" autocomplete="off" /></label>
							<button type="button" class="button danger" :disabled="!deletionConfirmed || deleting || saving" @click="remove"><Trash2 :size="17" />{{ deleting ? 'Removing…' : 'Remove Library Permanently' }}</button>
						</div>
					</AnimatedDisclosure>
				</form>
			</div>
		</Transition>
	</Teleport>
</template>
