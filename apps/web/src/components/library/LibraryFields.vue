<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch, watchEffect } from 'vue';
import { ChevronDown, File, Folder, LibraryBig, Settings2 } from '@lucide/vue';
import {
	isOnDiskSourceConfig, libraryCreateSchema, mediaServerCreateSchema, mediaServerUpdateSchema,
	type LibraryCreate, type LibraryUpdate, type MediaServer, type MediaServerCreate,
	type MediaServerProvider, type RemoteLibraryChoice,
} from '@moirai/shared';
import { api } from '../../api';
import { cloneContractValue } from '../../reactive-clone';
import { errorMessage } from '../../error-message';
import FormDisclosure from '../FormDisclosure.vue';
import EditorCard from '../media-servers/EditorCard.vue';
import SourceSelector from '../media-servers/SourceSelector.vue';
import MediaServerConnectionCards from '../media-servers/MediaServerConnectionCards.vue';
import MediaServerFolderMappings from '../media-servers/MediaServerFolderMappings.vue';
import type { MediaServerProbeResult } from '../media-servers/useMediaServerConnection';

const props = withDefaults(defineProps<{ creating?: boolean; resetKey?: number; disabled?: boolean }>(), { creating: false, resetKey: 0, disabled: false });
const emit = defineEmits<{ busy: [value: boolean]; error: [value: string] }>();
const form = defineModel<LibraryUpdate>('form', { required: true });
const ready = defineModel<boolean>('ready', { default: false });
const draftDirty = defineModel<boolean>('draftDirty', { default: false });
const servers = ref<MediaServer[]>([]);
const serversState = ref<'loading' | 'ready' | 'error'>('loading');
const serversError = ref('');
const connectionError = ref('');
const selectedServerId = ref('new');
const connection = ref<MediaServerCreate>(newConnection('plex'));
const connectionBaseline = ref(JSON.stringify(connection.value));
const connectionKey = ref(0);
const authenticationDirty = ref(false);
const testing = ref(false);
const remoteLibraries = ref<RemoteLibraryChoice[]>([]);
const remoteLibraryId = ref('');
const librariesState = ref<'idle' | 'loading' | 'ready' | 'error'>('idle');
const attached = ref<{ serverId: string; typeKey: string; libraryId: string; name: string } | null>(null);
const attachmentIntact = ref(true);
const provider = computed(() => form.value.sourceType === 'plex' || form.value.sourceType === 'jellyfin' || form.value.sourceType === 'emby' ? form.value.sourceType : null);
const matchingServers = computed(() => servers.value.filter((server) => server.provider === provider.value));
const savedServer = computed(() => matchingServers.value.find((server) => server.id === selectedServerId.value));
const diskRoot = computed(() => form.value.sourceConfig && isOnDiskSourceConfig(form.value.sourceConfig) ? form.value.sourceConfig.scanRoot : '');
const diskPlayback = computed(() => form.value.sourceConfig && isOnDiskSourceConfig(form.value.sourceConfig) ? form.value.sourceConfig.playbackRoot ?? '' : '');
const matchingAttachment = computed(() => {
	const original = attached.value;
	return original?.serverId === selectedServerId.value && original.typeKey === form.value.typeKey ? original : null;
});
const selectedRemoteLibrary = computed(() => remoteLibraries.value.find(library => library.id === remoteLibraryId.value));
const unlistedAttachment = computed(() => {
	const original = matchingAttachment.value;
	return original && !remoteLibraries.value.some(library => library.id === original.libraryId) ? original : null;
});
const reusableAttachment = computed(() => {
	if (!attachmentIntact.value || !matchingAttachment.value) {
		return false;
	}

	const saved = savedServer.value;
	return serversState.value === 'error' || Boolean(saved && saved.provider === provider.value
		&& saved.baseUrl === connection.value.baseUrl && saved.allowInsecureTls === connection.value.allowInsecureTls
		&& saved.clientIdentifier === connection.value.clientIdentifier && !connection.value.accessToken && !authenticationDirty.value);
});
let hydration = 0;

/** Construct an isolated empty connection when changing providers or choosing New server. */
function newConnection(source: MediaServerProvider): MediaServerCreate {
	return { provider: source, name: '', baseUrl: '', accessToken: '', allowInsecureTls: false, playbackReportingEnabled: false, pathReplacements: [] };
}

/** Restore a saved connection without retrieving its write-only credential. */
function savedConnection(server: MediaServer): MediaServerCreate {
	return {
		provider: server.provider, name: server.name, baseUrl: server.baseUrl, accessToken: '',
		playbackReportingEnabled: server.playbackReportingEnabled,
		allowInsecureTls: server.allowInsecureTls, pathReplacements: cloneContractValue(server.pathReplacements),
		clientIdentifier: server.clientIdentifier,
	};
}

/** Forget discovery from changed inputs while retaining an unchanged attached library offline. */
function invalidateLibraries(): void {
	remoteLibraries.value = [];
	librariesState.value = 'idle';
	remoteLibraryId.value = reusableAttachment.value ? attached.value!.libraryId : '';
}

/** Replace credential ownership and discovery together when selecting a different saved server. */
function selectServer(id: string): void {
	selectedServerId.value = id;
	const saved = savedServer.value;
	connection.value = saved ? savedConnection(saved) : newConnection(provider.value ?? 'plex');
	connectionBaseline.value = JSON.stringify(connection.value);
	authenticationDirty.value = false;
	testing.value = false;
	emit('busy', false);
	connectionKey.value += 1;
	invalidateLibraries();
}

/** Preserve the original attached selection even if the saved-server list is temporarily offline. */
function rememberAttachment(): void {
	const config = form.value.sourceConfig;
	attached.value = config && !isOnDiskSourceConfig(config) ? {
		serverId: config.mediaServerId, libraryId: config.remoteLibraryId,
		name: config.remoteLibraryName, typeKey: form.value.typeKey ?? '',
	} : null;
	attachmentIntact.value = true;
}

/** Load saved servers and bind the current draft rather than a stale provider from before loading. */
async function hydrate(): Promise<void> {
	const request = ++hydration;
	rememberAttachment();
	serversState.value = 'loading';
	serversError.value = '';
	connectionKey.value += 1;
	try {
		const result = await api.mediaServers();
		if (request !== hydration) {
			return;
		}

		servers.value = result;
		serversState.value = 'ready';
		selectServer(attached.value?.serverId ?? matchingServers.value[0]?.id ?? 'new');
	}
	catch (cause) {
		if (request !== hydration) {
			return;
		}

		serversState.value = 'error';
		serversError.value = errorMessage(cause);
		selectedServerId.value = attached.value?.serverId ?? 'new';
		invalidateLibraries();
	}
}

/** Select a source without allowing another provider to inherit its temporary credentials. */
function selectSource(source: 'on-disk' | MediaServerProvider): void {
	if (form.value.sourceType === source || props.disabled) {
		return;
	}

	form.value.sourceType = source;
	if (source === 'on-disk') {
		form.value.sourceConfig = { scanRoot: diskRoot.value, playbackRoot: diskPlayback.value || null };
	}
	else {
		form.value.watcherEnabled = false;
	}
	selectServer(matchingServers.value[0]?.id ?? 'new');
}

/** Keep an existing attachment until the operator chooses a replacement. */
function tested(result: MediaServerProbeResult): void {
	if (!connection.value.name.trim()) {
		connection.value.name = result.serverName;
	}

	remoteLibraries.value = result.libraries;
	librariesState.value = 'ready';
	if (!selectedRemoteLibrary.value) {
		const original = matchingAttachment.value;
		remoteLibraryId.value = original ? (attachmentIntact.value ? original.libraryId : '') : result.libraries[0]?.id ?? '';
	}
}

/** Mark a manually replaced attachment so a type toggle does not silently restore it. */
function selectRemoteLibrary(): void {
	if (attached.value) {
		attachmentIntact.value = matchingAttachment.value?.libraryId === remoteLibraryId.value;
	}
}

/** Surface testing state without preventing input edits that invalidate an in-flight response. */
function connectionBusy(value: boolean): void {
	testing.value = value;
	if (value) {
		librariesState.value = 'loading';
	}
	else if (librariesState.value === 'loading') {
		librariesState.value = 'error';
	}
	emit('busy', value);
}

/** Keep source paths on the shared library draft. */
function updatePath(scanRoot: string, playbackRoot: string): void {
	form.value.sourceConfig = { scanRoot, playbackRoot: playbackRoot || null };
}

watch([provider, serversError, connectionError], () => emit('error', provider.value ? serversError.value || connectionError.value : ''), { immediate: true });
watch(() => props.resetKey, () => void hydrate());
watch(() => form.value.typeKey, invalidateLibraries, { flush: 'sync' });
watchEffect(() => {
	const base = {
		name: form.value.name ?? '', typeKey: form.value.typeKey ?? '', sourceType: 'on-disk' as const,
		sourceConfig: { scanRoot: provider.value ? '/remote' : diskRoot.value, playbackRoot: null },
		scanIntervalMinutes: form.value.scanIntervalMinutes,
	};
	const validLibrary = libraryCreateSchema.safeParse(base).success;
	const serverInput = { ...connection.value, name: connection.value.name.trim() || form.value.name || '' };
	const validServer = (savedServer.value ? mediaServerUpdateSchema : mediaServerCreateSchema).safeParse(serverInput).success;
	const keepsAttachment = reusableAttachment.value && remoteLibraryId.value === matchingAttachment.value?.libraryId;
	const validRemote = serversState.value === 'error' ? keepsAttachment
		: validServer && (keepsAttachment || (librariesState.value === 'ready' && Boolean(selectedRemoteLibrary.value)));
	ready.value = validLibrary && !testing.value && (!provider.value || validRemote);
	draftDirty.value = Boolean(provider.value) && (authenticationDirty.value
		|| JSON.stringify(connection.value) !== connectionBaseline.value
		|| Boolean(attached.value && selectedServerId.value !== attached.value.serverId)
		|| Boolean(attached.value && remoteLibraryId.value && remoteLibraryId.value !== attached.value.libraryId));
});

/** Save changed connection settings, then return the complete library draft for its owning modal. */
async function prepareSource(): Promise<LibraryCreate> {
	if (!ready.value) {
		throw new Error('Check the library details and test the selected connection before saving');
	}

	const common = {
		name: form.value.name!.trim(), typeKey: form.value.typeKey!,
		scanIntervalMinutes: form.value.scanIntervalMinutes!, enabled: form.value.enabled ?? true,
	};
	if (!provider.value) {
		return { ...common, sourceType: 'on-disk', sourceConfig: { scanRoot: diskRoot.value.trim(), playbackRoot: diskPlayback.value.trim() || null }, watcherEnabled: form.value.watcherEnabled ?? true };
	}

	const chosenLibrary = remoteLibraryId.value;
	const chosenName = selectedRemoteLibrary.value?.name ?? matchingAttachment.value?.name ?? chosenLibrary;
	let id = selectedServerId.value;
	if (serversState.value !== 'error') {
		const input = { ...cloneContractValue(connection.value), name: connection.value.name.trim() || common.name };
		const changed = JSON.stringify(connection.value) !== connectionBaseline.value;
		if (!savedServer.value || changed) {
			const server = savedServer.value
				? await api.updateMediaServer(savedServer.value.id, mediaServerUpdateSchema.parse(input))
				: await api.createMediaServer(mediaServerCreateSchema.parse(input));
			servers.value = [...servers.value.filter((entry) => entry.id !== server.id), server];
			id = server.id;
			selectedServerId.value = id;
			connection.value = savedConnection(server);
			connectionBaseline.value = JSON.stringify(connection.value);
			connectionKey.value += 1;
			authenticationDirty.value = false;
		}
	}

	const sourceConfig = { mediaServerId: id, remoteLibraryId: chosenLibrary, remoteLibraryName: chosenName };
	form.value.sourceConfig = sourceConfig;
	return { ...common, sourceType: provider.value, sourceConfig, watcherEnabled: false };
}

void hydrate();
onBeforeUnmount(() => {
	hydration += 1;
});
defineExpose({ prepareSource });
</script>
<template>
	<div class="source-editor-sections">
		<SourceSelector :value="form.sourceType ?? 'on-disk'" :disabled="disabled" @select="selectSource" />
		<EditorCard title="Library Details" description="Basic information about this library." :icon="File">
			<label><span>Name</span><input v-model="form.name" :disabled="disabled" required maxlength="120" autocapitalize="words" placeholder="e.g. My Movies" /></label>
			<label><span>Type</span><select v-model="form.typeKey" :disabled="disabled"><option value="movies">Movies</option><option value="shows">Shows</option><option value="music-videos">Music videos</option><option value="other">Other</option></select></label>
		</EditorCard>
		<EditorCard v-if="!provider" title="Folder" description="Choose the folder Moirai scans for media and NFO metadata." :icon="Folder">
			<label class="span-2"><span>Path Moirai scans</span><input :value="diskRoot" :disabled="disabled" required @input="updatePath(($event.target as HTMLInputElement).value, diskPlayback)" /></label>
		</EditorCard>
		<template v-else>
			<p v-if="serversState === 'loading'" class="source-editor-hint">Loading saved servers…</p>
			<div v-else-if="serversState === 'error'"><p class="source-editor-hint">Saved servers could not be loaded.</p><button class="button secondary" type="button" @click="hydrate">Retry Saved Servers</button></div>
			<MediaServerConnectionCards v-else :key="connectionKey" v-model="connection" :saved="savedServer" :type-key="form.typeKey ?? 'movies'" :disabled="disabled" :auto-test="librariesState !== 'ready'" @tested="tested" @invalidated="invalidateLibraries" @busy="connectionBusy" @dirty="authenticationDirty = $event" @error="connectionError = $event">
				<template #server-selector><label><span>Server</span><select :value="selectedServerId" :disabled="disabled" @change="selectServer(($event.target as HTMLSelectElement).value)"><option v-for="server in matchingServers" :key="server.id" :value="server.id">{{ server.name }} · {{ server.serverName }}</option><option value="new">New server</option></select></label></template>
			</MediaServerConnectionCards>
			<EditorCard v-if="librariesState !== 'idle' || remoteLibraryId" title="Remote Library" description="Choose the library to index from this server." :icon="LibraryBig">
				<p v-if="librariesState === 'loading'" class="span-2 source-editor-hint" role="status">Loading remote libraries…</p>
				<p v-else-if="librariesState === 'error'" class="span-2 source-editor-hint">The connection could not be tested. Check the connection details and try again.</p>
				<template v-else-if="librariesState === 'ready'">
					<p v-if="!remoteLibraries.length" class="span-2 source-editor-hint">{{ provider === 'plex' && form.typeKey === 'music-videos' ? 'Plex does not offer music-video libraries. Choose Movies, Shows, or Other.' : 'No matching libraries were found for this type.' }}</p>
					<label v-if="remoteLibraries.length || unlistedAttachment" class="span-2"><span>Remote library</span><select v-model="remoteLibraryId" :disabled="disabled" @change="selectRemoteLibrary">
						<option value="" disabled>Choose a library</option>
						<option v-if="unlistedAttachment" :value="unlistedAttachment.libraryId">{{ unlistedAttachment.name }} (unavailable)</option>
						<option v-for="library in remoteLibraries" :key="library.id" :value="library.id">{{ library.name }}</option>
					</select></label>
				</template>
				<p v-else class="span-2 source-editor-hint">Saved library: {{ attached?.name }}</p>
			</EditorCard>
		</template>
		<FormDisclosure class="source-editor-advanced"><template #summary><Settings2 :size="20" aria-hidden="true" /><strong class="form-disclosure-copy">Advanced</strong><ChevronDown class="form-disclosure-chevron" :size="20" aria-hidden="true" /></template><div class="form-grid">
			<template v-if="!provider"><label class="span-2"><span>Path playback engine sees <small>optional</small></span><input :value="diskPlayback" :disabled="disabled" @input="updatePath(diskRoot, ($event.target as HTMLInputElement).value)" /></label><label class="check span-2"><input v-model="form.watcherEnabled" :disabled="disabled" type="checkbox" />Watch for changes</label></template>
			<label><span>{{ provider ? 'Scan every, minutes' : 'Fallback scan, minutes' }}</span><input v-model.number="form.scanIntervalMinutes" :disabled="disabled" type="number" inputmode="numeric" min="1" max="10080" required /></label>
			<MediaServerFolderMappings v-if="provider && serversState === 'ready'" v-model="connection.pathReplacements" :disabled="disabled" />
		</div></FormDisclosure>
		<label v-if="!creating" class="check"><input v-model="form.enabled" :disabled="disabled" type="checkbox" />Enabled for scheduling</label>
	</div>
</template>
