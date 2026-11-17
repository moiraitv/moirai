<script setup lang="ts">
import { useResourceDraft } from '../../composables/useResourceDraft';
import LibraryFields from './LibraryFields.vue';
import { useDraftProtection } from '../../draft-protection';
import PageHelpButton from '../PageHelpButton.vue';
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { libraryCreateSchema, libraryUpdateSchema, DEFAULT_FALLBACK_SCAN_INTERVAL_MINUTES, type Library, type LibraryCreate, type LibraryUpdate } from '@moirai/shared';
import { api } from '../../api';
import { requestConfirmation } from '../../confirmation';
import { errorMessage } from '../../error-message';
import { useAnimatedDismissal } from '../../motion';
import { cloneContractValue } from '../../reactive-clone';
import { closeUnsavedEditor, confirmDraftNavigation } from '../../unsaved-editor';
import ResourceEditorActionBar from '../ResourceEditorActionBar.vue';
import ResourceEditorHeader from '../ResourceEditorHeader.vue';

const props = defineProps<{ library?: Library | undefined; existingLibraries?: Library[] | undefined }>();
const emit = defineEmits<{
	close: [];
	deleted: [];
	saved: [library: Library];
}>();
const library = ref(props.library);
const dialog = ref<HTMLElement>();
const saving = ref(false);
const testing = ref(false);
const deleting = ref(false);
const error = ref('');
const connectionError = ref('');
let allowRouteLeave = false;
let baseline: LibraryUpdate = library.value ? {
	name: library.value.name,
	typeKey: library.value.typeKey,
	sourceType: library.value.sourceType,
	sourceConfig: cloneContractValue(library.value.sourceConfig),
	scanIntervalMinutes: library.value.scanIntervalMinutes,
	watcherEnabled: library.value.watcherEnabled,
	enabled: library.value.enabled,
} : {
	name: '', typeKey: 'movies', sourceType: 'on-disk', sourceConfig: { scanRoot: '', playbackRoot: null },
	scanIntervalMinutes: DEFAULT_FALLBACK_SCAN_INTERVAL_MINUTES, watcherEnabled: true, enabled: true,
};
const form = reactive<LibraryUpdate>(cloneContractValue(baseline));
const originalSnapshot = ref(JSON.stringify(baseline));
const draftDirty = ref(false);
const ready = ref(false);
const resetKey = ref(0);
const fields = ref<{ prepareSource: () => Promise<LibraryCreate> }>();
const isDirty = computed(() => draftDirty.value || JSON.stringify(form) !== originalSnapshot.value);
const retained = useResourceDraft({
	kind: 'library', identity: () => library.value?.id ?? 'new', capture: () => form,
	nullableSchema: libraryUpdateSchema,
	restore: fields => Object.assign(form, fields), dirty: () => isDirty.value,
});
const { warning: draftWarning } = retained;
const { visible, requestClose: dismiss, finishClose } = useAnimatedDismissal(() => emit('close'));

/** Create or update the library and adopt its saved identity within the same editor. */
async function save(): Promise<void> {
	if (saving.value || deleting.value || (library.value && !isDirty.value) || !ready.value || !fields.value) {
		return;
	}

	saving.value = true;
	error.value = '';
	try {
		const prepared = await fields.value.prepareSource();
		const update = {
			name: prepared.name,
			typeKey: prepared.typeKey,
			sourceType: prepared.sourceType,
			sourceConfig: prepared.sourceConfig,
			scanIntervalMinutes: prepared.scanIntervalMinutes,
			watcherEnabled: prepared.watcherEnabled,
			enabled: prepared.enabled,
		};
		if (!libraryUpdateSchema.safeParse(update).success) {
			error.value = 'Check the library details and try again.';
			return;
		}

		const saved = library.value
			? await api.updateLibrary(library.value.id, update)
			: await api.createLibrary(libraryCreateSchema.parse(prepared));
		retained.clear();
		library.value = saved;
		// Keep the submitted source until reconciliation accepts the replacement.
		Object.assign(form, prepared, { name: saved.name });
		baseline = cloneContractValue(form);
		originalSnapshot.value = JSON.stringify(baseline);
		draftDirty.value = false;
		resetKey.value += 1;
		await retained.open(originalSnapshot.value, false);
		emit('saved', saved);
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
	retained.clear();
	Object.assign(form, cloneContractValue(baseline));
	void retained.open(originalSnapshot.value, false);
	resetKey.value += 1;
	error.value = '';
}

/** Forget recovered creation data only when the complete draft is already persisted. */
function discardCommittedDraft(): void {
	if (library.value || !retained.recovered.value || draftDirty.value) {
		return;
	}

	const draft = libraryCreateSchema.safeParse(form);
	if (!draft.success) {
		return;
	}
	const snapshot = JSON.stringify(draft.data);
	const committed = props.existingLibraries?.some(existing => {
		const saved = libraryCreateSchema.safeParse(existing);
		return saved.success && JSON.stringify(saved.data) === snapshot;
	});
	if (committed) {
		reset();
	}
}
watch([() => props.existingLibraries, retained.recovered, draftDirty], discardCommittedDraft);

/** Save, discard, or retain library settings before closing the modal. */
async function closeEditor(): Promise<void> {
	await closeUnsavedEditor({
		...(draftDirty.value ? {} : { retainedDraft: retained }), isDirty: () => isDirty.value,
		blocked: saving.value || deleting.value || testing.value,
		dirty: isDirty.value,
		key: `unsaved-library:${library.value?.id ?? 'new'}`,
		message: library.value ? 'Save these library settings before closing?' : 'Save this library before closing?',
		saveLabel: 'Save Settings',
		save,
		discard: dismiss,
	});
}

/** Permanently remove the configured library after exact-name modal confirmation. */
async function remove(): Promise<void> {
	const saved = library.value;
	if (!saved || saving.value || deleting.value || !(await requestConfirmation({
		key: `delete-library:${saved.id}`,
		title: 'Delete Library?',
		message: 'This permanently deletes the library configuration, index, and cached artwork from Moirai. Source media files are not changed.',
		confirmLabel: 'Delete Library',
		destructive: true,
		requiredText: saved.name,
		requiredTextLabel: `Type ${saved.name} to confirm`,
	}))) {
		return;
	}

	deleting.value = true;
	error.value = '';
	try {
		await api.deleteLibrary(saved.id);
		retained.clear();
		allowRouteLeave = true;
		emit('deleted');
	}
	catch (cause) {
		error.value = errorMessage(cause);
	}
	finally {
		deleting.value = false;
	}
}

onMounted(async () => {
	await retained.open(originalSnapshot.value);
	resetKey.value += 1;
	dialog.value?.querySelector('input')?.focus();
});
/** Protect a library draft when its route or resource identity changes. */
async function confirmNavigation(): Promise<boolean> {
	if (allowRouteLeave || !visible.value) {
		return true;
	}

	const proceed = await confirmDraftNavigation({
		blocked: saving.value || deleting.value || testing.value, dirty: isDirty.value,
		...(draftDirty.value ? {} : { retainedDraft: retained }), isDirty: () => isDirty.value,
		key: `unsaved-library:${library.value?.id ?? 'new'}`, message: 'Save these library settings before leaving?', save,
	});
	return proceed || (!saving.value && !deleting.value && !testing.value && !isDirty.value);
}
defineExpose({ confirmNavigation });
useDraftProtection(() => visible.value && isDirty.value && (draftDirty.value || retained.unsafe.value));
</script>

<template>
	<Teleport to="body">
		<Transition name="moirai-overlay" appear @after-leave="finishClose">
			<div v-show="visible" class="moirai-dialog-backdrop" :inert="!visible" :aria-hidden="!visible" @click.self="closeEditor" @keydown.esc.stop.prevent="closeEditor">
				<form
					ref="dialog"
					v-modal-focus="{ escape: closeEditor }"
					class="moirai-dialog resource-editor-modal library-settings-modal source-editor-modal" role="dialog"
					aria-modal="true"
					aria-labelledby="library-settings-title"
					@submit.prevent="save"
				>
					<ResourceEditorHeader close-label="Close library editor" :disabled="saving || deleting" @close="closeEditor">
						<p v-if="library" class="eyebrow">Library settings</p>
						<div class="resource-editor-title-with-help"><h2 id="library-settings-title">{{ library ? `Library settings for ${library.name}` : 'Add Library' }}</h2><PageHelpButton label="Libraries" topic-id="libraries.manage" /><p v-if="!library" class="source-editor-subtitle">Add a new media library to Moirai.</p></div>

						<template #notice>
							<div v-if="error || connectionError" class="source-editor-errors">
								<p v-if="error" class="notice error" role="alert">{{ error }}</p>
								<p v-if="connectionError" class="notice error" role="alert">{{ connectionError }}</p>
							</div>
						</template>
					</ResourceEditorHeader>

					<div :inert="saving || deleting" class="resource-editor-scroll library-settings-scroll">
						<LibraryFields ref="fields" v-model:ready="ready" v-model:draft-dirty="draftDirty" :form="form" :reset-key="resetKey" :disabled="saving || deleting" :creating="!library" @update:form="Object.assign(form, $event)" @busy="testing = $event" @error="connectionError = $event" />

						<p v-if="library" class="library-settings-note">Changing the source path or library identity can require index reconciliation. Run a sync after saving to inspect the new source.</p>
					</div>

					<ResourceEditorActionBar
						:pending="!library || isDirty" :draft-warning="draftWarning" :draft-restored="retained.recovered.value" resource-type="Library"
						:show-delete="Boolean(library)"
						:save-label="library ? 'Save' : 'Add and Scan'" :saving-label="library ? 'Saving…' : 'Adding…'"
						:busy="saving || deleting || testing"
						:deleting="deleting"
						:reset-disabled="!isDirty"
						:save-disabled="!isDirty || !ready"
						save-submits
						:saving="saving"
						@close="closeEditor"
						@delete="remove"
						@reset="reset"
					/>
				</form>
			</div>
		</Transition>
	</Teleport>
</template>
