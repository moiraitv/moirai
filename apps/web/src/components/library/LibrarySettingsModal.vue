<script setup lang="ts">
import { activeHelpTopic } from '../../help';
import PageHelpButton from '../PageHelpButton.vue';
import { computed, onMounted, reactive, ref, useTemplateRef } from 'vue';
import { libraryUpdateSchema, type Library, type LibraryUpdate } from '@moirai/shared';
import { api } from '../../api';
import { requestConfirmation } from '../../confirmation';
import { errorMessage } from '../../error-message';
import { useAnimatedDismissal } from '../../motion';
import { cloneContractValue } from '../../reactive-clone';
import { closeUnsavedEditor } from '../../unsaved-editor';
import ResourceEditorActionBar from '../ResourceEditorActionBar.vue';
import ResourceEditorHeader from '../ResourceEditorHeader.vue';

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
const baseline: LibraryUpdate = {
	name: props.library.name,
	typeKey: props.library.typeKey,
	sourceType: props.library.sourceType,
	sourceConfig: { ...props.library.sourceConfig },
	scanIntervalMinutes: props.library.scanIntervalMinutes,
	watcherEnabled: props.library.watcherEnabled,
	enabled: props.library.enabled,
};
const form = reactive<LibraryUpdate>(cloneContractValue(baseline));
const originalSnapshot = JSON.stringify(baseline);
const isDirty = computed(() => JSON.stringify(form) !== originalSnapshot);
const formValid = computed(() => libraryUpdateSchema.safeParse({
	...form,
	sourceConfig: form.sourceConfig
		? { ...form.sourceConfig, playbackRoot: form.sourceConfig.playbackRoot || null }
		: undefined,
}).success);
const { visible, requestClose: dismiss, finishClose } = useAnimatedDismissal(() => emit('close'));

/** Save the editable library configuration and return the authoritative record. */
async function save(): Promise<void> {
	if (saving.value || deleting.value || !isDirty.value || !formValid.value) {
		return;
	}

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

/** Restore every editable library setting to the baseline captured on open. */
function reset(): void {
	Object.assign(form, cloneContractValue(baseline));
	error.value = '';
}

/** Save, discard, or retain library settings before closing the modal. */
async function closeEditor(): Promise<void> {
	await closeUnsavedEditor({
		blocked: saving.value || deleting.value,
		dirty: isDirty.value,
		key: `unsaved-library:${props.library.id}`,
		message: 'Save these library settings before closing?',
		saveLabel: 'Save Settings',
		save,
		discard: dismiss,
	});
}

/** Permanently remove the configured library after exact-name modal confirmation. */
async function remove(): Promise<void> {
	if (saving.value || deleting.value || !(await requestConfirmation({
		key: `delete-library:${props.library.id}`,
		title: 'Delete Library?',
		message: 'This permanently deletes the library configuration, index, and cached artwork from Moirai. Source media files are not changed.',
		confirmLabel: 'Delete Library',
		destructive: true,
		requiredText: props.library.name,
		requiredTextLabel: `Type ${props.library.name} to confirm`,
	}))) {
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

onMounted(() => nameInput.value?.focus());
</script>

<template>
	<Teleport to="body">
		<Transition name="moirai-overlay" appear @after-leave="finishClose">
			<div v-show="visible" class="moirai-dialog-backdrop" :inert="!visible || Boolean(activeHelpTopic)" :aria-hidden="!visible" @click.self="closeEditor" @keydown.esc.stop.prevent="closeEditor">
				<form
					class="moirai-dialog resource-editor-modal library-settings-modal"
					role="dialog"
					aria-modal="true"
					aria-labelledby="library-settings-title"
					@submit.prevent="save"
				>
					<ResourceEditorHeader close-label="Close library editor" :disabled="saving || deleting" @close="closeEditor">
						<p class="eyebrow">Library settings</p>
						<div class="resource-editor-title-with-help"><h2 id="library-settings-title">Library settings for {{ library.name }}</h2><PageHelpButton label="Libraries" topic-id="libraries.manage" /></div>
					</ResourceEditorHeader>

					<div class="resource-editor-scroll library-settings-scroll">
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
					</div>

					<ResourceEditorActionBar
						resource-type="Library"
						show-delete
						:busy="saving || deleting"
						:deleting="deleting"
						:reset-disabled="!isDirty"
						:save-disabled="!isDirty || !formValid"
						save-submits
						:saving="saving"
						@delete="remove"
						@reset="reset"
					/>
				</form>
			</div>
		</Transition>
	</Teleport>
</template>
