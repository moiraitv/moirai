<script setup lang="ts">
import { computed, reactive, ref, onMounted } from 'vue';
import { onBeforeRouteLeave } from 'vue-router';
import { libraryCreateSchema, DEFAULT_FALLBACK_SCAN_INTERVAL_MINUTES, type LibraryCreate } from '@moirai/shared';
import { api } from '../../api';
import { errorMessage } from '../../error-message';
import { requestConfirmation } from '../../confirmation';
import { useDraftProtection } from '../../draft-protection';
import { closeUnsavedEditor } from '../../unsaved-editor';
import { useAnimatedDismissal } from '../../motion';
import LibraryFields from './LibraryFields.vue';
import ResourceEditorHeader from '../ResourceEditorHeader.vue';
import ResourceEditorActionBar from '../ResourceEditorActionBar.vue';
import PageHelpButton from '../PageHelpButton.vue';

const emit = defineEmits<{ close: []; saved: [] }>();
const form = reactive<LibraryCreate>({ name: '', typeKey: 'movies', sourceType: 'on-disk', sourceConfig: { scanRoot: '', playbackRoot: null }, scanIntervalMinutes: DEFAULT_FALLBACK_SCAN_INTERVAL_MINUTES, watcherEnabled: true, enabled: true });
const baseline = JSON.stringify(form);
const dirty = computed(() => JSON.stringify(form) !== baseline);
const body = computed(() => ({ ...form, sourceConfig: { ...form.sourceConfig, playbackRoot: form.sourceConfig.playbackRoot || null } }));
const valid = computed(() => libraryCreateSchema.safeParse(body.value).success);
const busy = ref(false);
const error = ref('');
const saved = ref(false);
const dialog = ref<HTMLElement>();
const { visible, requestClose: dismiss, finishClose } = useAnimatedDismissal(() => emit('close'));
/** Create and queue the initial scan through the existing library operation. */
async function save(): Promise<void> {
	if (busy.value || !valid.value) {
		return;
	}
	busy.value = true;
	error.value = '';
	try {
		await api.createLibrary(body.value);
		saved.value = true;
		emit('saved');
		dismiss();
	}
	catch (cause) {
		error.value = errorMessage(cause);
	}
	finally {
		busy.value = false;
	}
}
/** Route every editor dismissal through the same draft decision. */
async function close(): Promise<void> {
	await closeUnsavedEditor({ blocked: busy.value, dirty: dirty.value && !saved.value, key: 'unsaved-new-library', message: 'Save this library before closing?', save, discard: dismiss });
}
useDraftProtection(() => dirty.value && !saved.value && visible.value);
onBeforeRouteLeave(async () => !busy.value && (saved.value || !dirty.value || await requestConfirmation({ key: 'discard-new-library', title: 'Discard Unsaved Changes?', message: 'Leave without adding this library?', confirmLabel: 'Discard Changes', cancelLabel: 'Keep Editing', destructive: true })));
onMounted(() => dialog.value?.querySelector('input')?.focus());
</script>
<template>
	<Teleport to="body"><Transition name="moirai-overlay" appear @after-leave="finishClose">
		<div v-show="visible" class="moirai-dialog-backdrop" :inert="!visible" :aria-hidden="!visible" @click.self="close">
			<form ref="dialog" v-modal-focus="{ escape: close }" class="moirai-dialog resource-editor-modal library-settings-modal" role="dialog" aria-modal="true" aria-labelledby="library-create-title" @submit.prevent="save">
				<ResourceEditorHeader close-label="Close library editor" :disabled="busy" @close="close"><div class="resource-editor-title-with-help"><h2 id="library-create-title">Add Library</h2><PageHelpButton label="Libraries" topic-id="libraries.manage" /></div></ResourceEditorHeader>
				<div class="resource-editor-scroll library-settings-scroll"><LibraryFields :form="form" creating @update:form="Object.assign(form, $event)" /><p v-if="error" class="notice error" role="alert">{{ error }}</p></div>
				<ResourceEditorActionBar :busy="busy" :saving="busy" :reset-disabled="!dirty" :save-disabled="!valid" save-label="Add and Scan" saving-label="Adding…" save-submits @reset="Object.assign(form, JSON.parse(baseline)); error = ''" />
			</form>
		</div>
	</Transition></Teleport>
</template>
