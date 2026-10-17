<script setup lang="ts">
import { useResourceDraft } from '../../composables/useResourceDraft';
import { computed, reactive, ref, onMounted } from 'vue';
import { libraryCreateSchema, DEFAULT_FALLBACK_SCAN_INTERVAL_MINUTES, type LibraryCreate, type Library } from '@moirai/shared';
import { api } from '../../api';
import { errorMessage } from '../../error-message';
import { useDraftProtection } from '../../draft-protection';
import { closeUnsavedEditor, confirmDraftNavigation } from '../../unsaved-editor';
import { useAnimatedDismissal } from '../../motion';
import LibraryFields from './LibraryFields.vue';
import ResourceEditorHeader from '../ResourceEditorHeader.vue';
import ResourceEditorActionBar from '../ResourceEditorActionBar.vue';
import PageHelpButton from '../PageHelpButton.vue';

const emit = defineEmits<{ close: []; saved: [library: Library] }>();
const form = reactive<LibraryCreate>({ name: '', typeKey: 'movies', sourceType: 'on-disk', sourceConfig: { scanRoot: '', playbackRoot: null }, scanIntervalMinutes: DEFAULT_FALLBACK_SCAN_INTERVAL_MINUTES, watcherEnabled: true, enabled: true });
const baseline = JSON.stringify(form);
const dirty = computed(() => JSON.stringify(form) !== baseline);
const retained = useResourceDraft({
	kind: 'library', identity: () => 'new', capture: () => form,
	nullableSchema: libraryCreateSchema,
	restore: fields => Object.assign(form, fields), dirty: () => dirty.value,
});
const { warning: draftWarning } = retained;

/** Restore untouched new-library defaults and forget its retained fields. */
function reset(): void {
	retained.clear();
	Object.assign(form, JSON.parse(baseline));
	error.value = '';
	void retained.open(baseline, false);
}
const body = computed(() => ({ ...form, sourceConfig: { ...form.sourceConfig, playbackRoot: form.sourceConfig.playbackRoot || null } }));
const valid = computed(() => libraryCreateSchema.safeParse(body.value).success);
const busy = ref(false);
const error = ref('');
const saved = ref(false);
const dialog = ref<HTMLElement>();
const { visible, requestClose: dismiss, finishClose } = useAnimatedDismissal(() => emit('close'));
/** Create the Library without opening its settings during an accepted route departure. */
async function save(stayOnPage = false): Promise<void> {
	if (busy.value || !valid.value) {
		return;
	}
	busy.value = true;
	error.value = '';
	try {
		const library = await api.createLibrary(body.value);
		retained.clear();
		saved.value = true;
		if (!stayOnPage) {
			emit('saved', library);
		}
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
	await closeUnsavedEditor({ retainedDraft: retained, isDirty: () => dirty.value && !saved.value, blocked: busy.value, dirty: dirty.value && !saved.value, key: 'unsaved-new-library', message: 'Save this library before closing?', save, discard: dismiss });
}
useDraftProtection(() => dirty.value && !saved.value && visible.value && retained.unsafe.value);
/** Retain the new library draft during cancelled browser navigation. */
async function confirmNavigation(): Promise<boolean> {
	return saved.value || !visible.value || confirmDraftNavigation({
		blocked: busy.value, dirty: dirty.value, retainedDraft: retained,
		isDirty: () => dirty.value && !saved.value,
		key: 'unsaved-new-library', message: 'Save this library before leaving?', save: () => save(true),
	});
}
defineExpose({ confirmNavigation });
onMounted(async () => {
	await retained.open(baseline);
	dialog.value?.querySelector('input')?.focus();
});
</script>
<template>
	<Teleport to="body"><Transition name="moirai-overlay" appear @after-leave="finishClose">
		<div v-show="visible" class="moirai-dialog-backdrop" :inert="!visible" :aria-hidden="!visible" @click.self="close">
			<form ref="dialog" v-modal-focus="{ escape: close }" class="moirai-dialog resource-editor-modal library-settings-modal" role="dialog" aria-modal="true" aria-labelledby="library-create-title" @submit.prevent="save()">
				<ResourceEditorHeader close-label="Close library editor" :disabled="busy" @close="close"><div class="resource-editor-title-with-help"><h2 id="library-create-title">Add Library</h2><PageHelpButton label="Libraries" topic-id="libraries.manage" /></div></ResourceEditorHeader>
				<div :inert="busy" class="resource-editor-scroll library-settings-scroll"><LibraryFields :form="form" creating @update:form="Object.assign(form, $event)" /><p v-if="error" class="notice error" role="alert">{{ error }}</p></div>
				<ResourceEditorActionBar :draft-warning="draftWarning" :draft-restored="retained.recovered.value" :busy="busy" :saving="busy" :reset-disabled="!dirty" :save-disabled="!valid" save-label="Add and Scan" saving-label="Adding…" save-submits @reset="reset" />
			</form>
		</div>
	</Transition></Teleport>
</template>
