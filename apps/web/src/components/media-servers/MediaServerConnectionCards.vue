<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, watch } from 'vue';
import { Server, Radio, Eye, EyeOff, Info, Copy } from '@lucide/vue';
import { MEDIA_SERVER_PLAYBACK_REPORTING_PROVIDERS, type MediaServer, type MediaServerCreate } from '@moirai/shared';
import { mediaServerTransportWarning } from '../../media-server-transport';
import { useClipboardFeedback } from '../../composables/useClipboardFeedback';
import TransientToast from '../TransientToast.vue';
import EditorCard from './EditorCard.vue';
import { useMediaServerConnection, type MediaServerProbeResult } from './useMediaServerConnection';

const props = withDefaults(defineProps<{
	saved?: MediaServer | undefined;
	typeKey?: string;
	disabled?: boolean;
	autoTest?: boolean;
}>(), { saved: undefined, typeKey: 'movies', disabled: false, autoTest: false });
const form = defineModel<MediaServerCreate>({ required: true });
const emit = defineEmits<{
	tested: [result: MediaServerProbeResult];
	invalidated: [];
	busy: [value: boolean];
	dirty: [value: boolean];
	error: [value: string];
}>();
const connection = useMediaServerConnection(form, {
	saved: () => props.saved,
	typeKey: () => props.typeKey,
	invalidate: () => emit('invalidated'),
});
const { method, username, password, passwordVisible, pinCode, testing, linking, busy, error, authDirty, canTest, startPlexPin } = connection;
const { message: copyMessage, error: copyError, copy: copyPlexCode } = useClipboardFeedback();
const reportingSupported = computed(() => MEDIA_SERVER_PLAYBACK_REPORTING_PROVIDERS.some(provider => provider === form.value.provider));
const providerName = computed(() => form.value.provider === 'plex' ? 'Plex' : 'Jellyfin');
const warning = computed(() => mediaServerTransportWarning(form.value.baseUrl, form.value.allowInsecureTls));
watch(busy, (value) => emit('busy', value), { immediate: true });
watch(authDirty, (value) => emit('dirty', value), { immediate: true });
watch([error, copyError], (messages) => emit('error', messages.filter(Boolean).join(' ')), { immediate: true });
onBeforeUnmount(() => emit('error', ''));

/** Publish discovery only when it still belongs to this editor's current connection inputs. */
async function testConnection(): Promise<void> {
	const result = await connection.testConnection();
	if (result) {
		emit('tested', result);
	}
}

onMounted(() => {
	if (props.autoTest && props.saved) {
		void testConnection();
	}
});
defineExpose({ testConnection });
</script>
<template>
	<EditorCard title="Server" :description="$slots['server-selector'] ? 'Choose an existing server or add a new one.' : saved ? 'Update this shared server connection.' : 'Add a shared media server connection.'" :icon="Server">
		<slot name="server-selector" />
		<label :class="{ 'span-2': !$slots['server-selector'] }"><span>Server name</span><input v-model="form.name" :disabled="disabled" maxlength="120" :placeholder="`e.g. Home ${form.provider === 'plex' ? 'Plex' : form.provider === 'jellyfin' ? 'Jellyfin' : 'Emby'}`" /></label>
		<div class="span-2 source-editor-address-row">
			<label><span>Server address</span><input v-model="form.baseUrl" :disabled="disabled" type="url" autocapitalize="off" placeholder="https://media.example:32400" /></label>
			<label class="source-editor-tls"><input v-model="form.allowInsecureTls" :disabled="disabled" type="checkbox" role="switch" /><span>Allow untrusted certificate<small>Use this if your server has a self-signed certificate.</small></span></label>
		</div>
		<div class="span-2 source-editor-auth-row">
			<label><span>Authentication method</span><select v-model="method" :disabled="disabled"><option v-if="saved?.hasCredential" value="saved">Keep saved credential</option><option v-if="form.provider === 'plex'" value="plex-sign-in">Sign in with Plex</option><option v-else value="password">Username and password</option><option value="key">{{ form.provider === 'plex' ? 'Plex token' : 'API key' }}</option></select></label>
			<div v-if="method === 'plex-sign-in'" class="source-editor-auth-action"><button class="button secondary" type="button" :disabled="disabled || busy" @click="startPlexPin">{{ linking ? 'Waiting for Plex…' : 'Sign in with Plex' }}</button></div>
			<label v-else-if="method === 'key'"><span>{{ form.provider === 'plex' ? 'Plex token' : 'API key' }}</span><input v-model="form.accessToken" :disabled="disabled" type="password" autocomplete="off" autocapitalize="off" /></label>
			<p v-else-if="method === 'saved'" class="source-editor-hint">A credential is saved for this server. Changing the address or accepting an untrusted certificate requires a fresh credential.</p>
		</div>
		<template v-if="method === 'password'">
			<label><span>Username</span><input v-model="username" :disabled="disabled" autocomplete="username" placeholder="e.g. admin" /></label>
			<label><span>Password</span><div class="source-editor-secret"><input v-model="password" :disabled="disabled" :type="passwordVisible ? 'text' : 'password'" autocomplete="current-password" placeholder="Your password" /><button class="icon-button" type="button" :disabled="disabled" :aria-label="passwordVisible ? 'Hide password' : 'Show password'" :aria-pressed="passwordVisible" @click="passwordVisible = !passwordVisible"><component :is="passwordVisible ? EyeOff : Eye" :size="21" /></button></div><small>{{ form.accessToken && !password ? 'Signed in for this draft. Test connection to refresh the library list.' : 'Used once to get an API key from the server.' }}</small></label>
		</template>
		<div v-if="method === 'plex-sign-in' && (pinCode || form.accessToken || copyMessage)" class="span-2 library-server-signin">
			<p v-if="form.accessToken && !linking" class="source-editor-hint" role="status">Signed in with Plex. Test the connection to continue.</p>
			<template v-if="pinCode">
				<div class="source-editor-link-row">
					<div class="source-editor-code-row">
						<label><span>Plex link code</span><input :value="pinCode" readonly autocomplete="off" :spellcheck="false" /></label>
						<button class="button secondary" type="button" :disabled="disabled" aria-label="Copy Plex link code" @click="copyPlexCode(pinCode, 'Plex link code')"><Copy :size="18" aria-hidden="true" />Copy</button>
					</div>
					<p>Enter this code at <a href="https://plex.tv/link" target="_blank" rel="noreferrer">plex.tv/link</a>, then test the connection.</p>
				</div>
				<p v-if="copyError" class="notice error">{{ copyError }} <button class="button secondary" type="button" @click="copyError = ''">Dismiss</button></p>
			</template>
			<TransientToast v-if="copyMessage" inline :message="copyMessage" @close="copyMessage = ''" />
		</div>
		<div class="span-2 source-editor-test-row"><button class="button secondary" type="button" :disabled="disabled || !canTest" @click="testConnection"><Radio :size="21" />{{ testing ? 'Testing…' : 'Test connection' }}</button></div>
		<p class="span-2 source-editor-hint"><Info :size="19" aria-hidden="true" />This server will be shared by every library that uses it.</p>
		<label v-if="reportingSupported" class="span-2 source-editor-tls"><input v-model="form.playbackReportingEnabled" :disabled="disabled" type="checkbox" role="switch" /><span>Report channel playback to {{ providerName }}<small>Show each active channel in {{ providerName }}'s dashboard. Reports can change the connected account's watch history and resume positions; use a dedicated Moirai account.</small></span></label>
		<p v-if="warning" class="span-2 notice warning" role="alert">{{ warning }}</p>
	</EditorCard>
</template>
