<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { Plus, Server } from '@lucide/vue';
import type { MediaServer } from '@moirai/shared';
import { api } from '../../api';
import { errorMessage } from '../../error-message';
import LoadingState from '../LoadingState.vue';
import MediaServerEditor from './MediaServerEditor.vue';

const emit = defineEmits<{ dirty: [value: boolean]; busy: [value: boolean]; attention: [value: boolean]; saved: [message: string] }>();
const servers = ref<MediaServer[]>([]);
const loading = ref(true);
const loadError = ref('');
const editing = ref(false);
const selected = ref<MediaServer>();
watch(loadError, (value) => emit('attention', Boolean(value)), { immediate: true });

/** Load saved connections with distinct initial, empty, and failed states. */
async function load(): Promise<void> {
	loading.value = true;
	loadError.value = '';
	try {
		servers.value = await api.mediaServers();
	}
	catch (cause) {
		loadError.value = errorMessage(cause);
	}
	finally {
		loading.value = false;
	}
}

/** Open a fresh editor for one saved connection or a new server. */
function edit(server?: MediaServer): void {
	selected.value = server;
	editing.value = true;
}

/** Release the modal and its draft protection after dismissal or a successful write. */
function close(): void {
	editing.value = false;
	selected.value = undefined;
	emit('dirty', false);
	emit('busy', false);
}

/** Replace the saved connection in the list without an additional collection request. */
function saved(server: MediaServer): void {
	const index = servers.value.findIndex((entry) => entry.id === server.id);
	if (index < 0) {
		servers.value.push(server);
	}
	else {
		servers.value.splice(index, 1, server);
	}

	close();
	emit('saved', 'Media server saved.');
}

/** Remove the deleted connection and confirm the completed action in a toast. */
function deleted(id: string): void {
	servers.value = servers.value.filter((server) => server.id !== id);
	close();
	emit('saved', 'Media server deleted.');
}

onMounted(() => void load());
</script>

<template>
	<section class="panel settings-section form-grid media-servers-settings-panel" aria-labelledby="media-servers-settings-heading">
		<header class="media-servers-settings-heading span-2">
			<div class="settings-card-heading">
				<span class="settings-card-icon"><Server :size="24" aria-hidden="true" /></span>
				<div><h2 id="media-servers-settings-heading">Media library servers</h2><p>Manage shared Plex, Jellyfin, and Emby connections. Choose a saved server when adding a library.</p></div>
			</div>
			<button class="button secondary" type="button" :disabled="loading || Boolean(loadError)" @click="edit()"><Plus :size="17" />Add Media Server</button>
		</header>
		<LoadingState v-if="loading" class="span-2" label="Loading media servers…" />
		<div v-else-if="loadError" class="span-2"><p class="notice error" role="alert">{{ loadError }}</p><button class="button secondary" type="button" @click="load">Retry Media Servers</button></div>
		<ul v-else-if="servers.length" class="media-server-list span-2">
			<li v-for="server in servers" :key="server.id">
				<div><strong>{{ server.name }}</strong><small>{{ server.provider === 'plex' ? 'Plex' : server.provider === 'jellyfin' ? 'Jellyfin' : 'Emby' }} · {{ server.baseUrl }}</small></div>
				<button class="button secondary" type="button" :aria-label="`Edit media server ${server.name}`" @click="edit(server)">Edit</button>
			</li>
		</ul>
		<p v-else class="span-2">No media servers saved yet.</p>
		<MediaServerEditor v-if="editing" :server="selected" @close="close" @saved="saved" @deleted="deleted" @tested="emit('saved', $event)" @dirty="emit('dirty', $event)" @busy="emit('busy', $event)" />
	</section>
</template>
