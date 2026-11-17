<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { ChevronDown } from '@lucide/vue';
import { mediaServerCreateSchema, mediaServerUpdateSchema, type MediaServer, type MediaServerCreate } from '@moirai/shared';
import { api } from '../../api';
import { requestConfirmation } from '../../confirmation';
import { errorMessage } from '../../error-message';
import { useAnimatedDismissal } from '../../motion';
import { cloneContractValue } from '../../reactive-clone';
import { closeUnsavedEditor } from '../../unsaved-editor';
import FormDisclosure from '../FormDisclosure.vue';
import ResourceEditorActionBar from '../ResourceEditorActionBar.vue';
import ResourceEditorHeader from '../ResourceEditorHeader.vue';
import MediaServerConnectionCards from './MediaServerConnectionCards.vue';
import MediaServerFolderMappings from './MediaServerFolderMappings.vue';
import SourceSelector from './SourceSelector.vue';
import type { MediaServerProbeResult } from './useMediaServerConnection';

const props = defineProps<{ server?: MediaServer | undefined }>();
const emit = defineEmits<{
	close: [];
	saved: [server: MediaServer];
	deleted: [id: string];
	dirty: [value: boolean];
	busy: [value: boolean];
	tested: [message: string];
}>();
const baseline: MediaServerCreate = {
	provider: props.server?.provider ?? 'plex',
	name: props.server?.name ?? '',
	baseUrl: props.server?.baseUrl ?? '',
	accessToken: '',
	allowInsecureTls: props.server?.allowInsecureTls ?? false,
	playbackReportingEnabled: props.server?.playbackReportingEnabled ?? false,
	pathReplacements: props.server?.pathReplacements.map((row) => ({ ...row })) ?? [],
};
const form = ref(cloneContractValue(baseline));
const connectionKey = ref(0);
const authenticationDirty = ref(false);
const testing = ref(false);
const originalSnapshot = JSON.stringify(baseline);
const dirty = computed(() => authenticationDirty.value || JSON.stringify(form.value) !== originalSnapshot);
const saving = ref(false);
const deleting = ref(false);
const busy = computed(() => saving.value || deleting.value || testing.value);
const error = ref('');
const connectionError = ref('');
const dialog = ref<HTMLElement>();
const valid = computed(() => Boolean(props.server?.hasCredential || form.value.accessToken.trim())
	&& (!authenticationDirty.value || Boolean(form.value.accessToken))
	&& (props.server ? mediaServerUpdateSchema : mediaServerCreateSchema).safeParse(form.value).success);
const { visible, requestClose: dismiss, finishClose } = useAnimatedDismissal(() => emit('close'));
watch(dirty, (value) => emit('dirty', value), { immediate: true });
watch(busy, (value) => emit('busy', value), { immediate: true });

/** Persist the connection after the server validates its identity and credential. */
async function save(): Promise<void> {
	if (busy.value || !dirty.value || !valid.value) {
		return;
	}

	saving.value = true;
	error.value = '';
	try {
		const server = props.server
			? await api.updateMediaServer(props.server.id, mediaServerUpdateSchema.parse(form.value))
			: await api.createMediaServer(mediaServerCreateSchema.parse(form.value));
		emit('dirty', false);
		emit('saved', server);
	}
	catch (cause) {
		error.value = errorMessage(cause);
	}
	finally {
		saving.value = false;
	}
}

/** Restore the captured server settings without retrieving its saved credential. */
function reset(): void {
	form.value = cloneContractValue(baseline);
	authenticationDirty.value = false;
	connectionKey.value += 1;
	error.value = '';
}

/** Route every dismissal through the same save-or-discard prompt. */
async function close(): Promise<void> {
	await closeUnsavedEditor({
		blocked: saving.value || deleting.value,
		dirty: dirty.value,
		key: `unsaved-media-server:${props.server?.id ?? 'new'}`,
		message: 'Save this media server before closing?',
		save,
		discard: dismiss,
	});
}

/** Delete an unused saved server after explicit permanent-deletion confirmation. */
async function remove(): Promise<void> {
	const server = props.server;
	if (!server || busy.value || !await requestConfirmation({
		key: `delete-media-server:${server.id}`,
		title: 'Delete Media Server?',
		message: `Delete ${server.name} and its saved credential? A server used by a library cannot be deleted.`,
		confirmLabel: 'Delete Media Server',
		destructive: true,
	})) {
		return;
	}

	deleting.value = true;
	error.value = '';
	try {
		await api.deleteMediaServer(server.id);
		emit('dirty', false);
		emit('deleted', server.id);
	}
	catch (cause) {
		error.value = errorMessage(cause);
	}
	finally {
		deleting.value = false;
	}
}

/** Confirm a connection test independently of saving the server draft. */
function tested(result: MediaServerProbeResult): void {
	if (!form.value.name.trim()) {
		form.value.name = result.serverName;
	}
	emit('tested', 'Media server connection successful.');
}

onMounted(() => dialog.value?.querySelector('input')?.focus());
</script>

<template>
	<Teleport to="body">
		<Transition name="moirai-overlay" appear @after-leave="finishClose">
			<div v-show="visible" class="moirai-dialog-backdrop" :inert="!visible" :aria-hidden="!visible" @click.self="close" @keydown.esc.stop.prevent="close">
				<form ref="dialog" v-modal-focus="{ escape: close }" class="moirai-dialog resource-editor-modal media-server-editor source-editor-modal" role="dialog" aria-modal="true" aria-labelledby="media-server-editor-heading" @submit.prevent="save">
					<ResourceEditorHeader close-label="Close media server editor" :disabled="saving || deleting" @close="close">
						<p class="eyebrow">Media library servers</p>
						<h2 id="media-server-editor-heading">{{ server ? 'Edit Media Server' : 'Add Media Server' }}</h2>

						<template #notice>
							<div v-if="error || connectionError" class="source-editor-errors">
								<p v-if="error" class="notice error" role="alert">{{ error }}</p>
								<p v-if="connectionError" class="notice error" role="alert">{{ connectionError }}</p>
							</div>
						</template>
					</ResourceEditorHeader>
					<div class="resource-editor-scroll source-editor-sections">
						<SourceSelector :value="form.provider" :include-folder="false" :disabled="Boolean(server) || saving || deleting" @select="form.provider = $event === 'on-disk' ? 'plex' : $event" />
						<MediaServerConnectionCards :key="connectionKey" v-model="form" :saved="server" :disabled="saving || deleting" @tested="tested" @busy="testing = $event" @dirty="authenticationDirty = $event" @error="connectionError = $event" />
						<FormDisclosure class="source-editor-advanced"><template #summary><strong class="form-disclosure-copy">Advanced</strong><ChevronDown class="form-disclosure-chevron" :size="20" aria-hidden="true" /></template><div class="form-grid"><MediaServerFolderMappings v-model="form.pathReplacements" :disabled="saving || deleting" /></div></FormDisclosure>
					</div>
					<ResourceEditorActionBar resource-type="Media Server" :show-delete="Boolean(server)" :busy="busy" :deleting="deleting" :reset-disabled="!dirty" :save-disabled="!dirty || !valid" :saving="saving" saving-label="Checking…" save-submits @delete="remove" @reset="reset" />
				</form>
			</div>
		</Transition>
	</Teleport>
</template>
