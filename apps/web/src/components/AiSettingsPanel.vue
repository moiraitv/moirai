<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { AI_WEB_SEARCH_DEFAULT_TIME_LIMIT_MINUTES, type AiProvider, type AiSettingsStatus,
	type AiSettingsSave, type AiWebSearchTimeLimitMinutes } from '@moirai/shared';
import { api } from '../api';
import { requestConfirmation } from '../confirmation';
import { errorMessage } from '../error-message';
import LoadingState from './LoadingState.vue';

const emit = defineEmits<{ dirty: [value: boolean]; saving: [value: boolean]; saved: [message: string] }>();
const providers: { id: AiProvider; label: string }[] = [
	{ id: 'openai', label: 'OpenAI' }, { id: 'anthropic', label: 'Anthropic' },
	{ id: 'xai', label: 'xAI' }, { id: 'openrouter', label: 'OpenRouter' },
	{ id: 'custom', label: 'Custom' },
];
const status = ref<AiSettingsStatus | null>(null);
const loading = ref(true);
const saving = ref(false);
const error = ref('');
const selected = ref<AiProvider>('openai');
const key = ref('');
const modelOverride = ref('');
const webSearch = ref(false);
const webSearchTimeLimitMinutes = ref<AiWebSearchTimeLimitMinutes>(AI_WEB_SEARCH_DEFAULT_TIME_LIMIT_MINUTES);
const baseUrl = ref('');
const protocol = ref<'chat-completions' | 'anthropic-messages'>('chat-completions');
const chatJsonMode = ref<'json_object' | 'json_schema' | 'prompt_only'>('json_object');
const allowInsecureHttp = ref(false);
const profile = computed(() => status.value?.profiles.find(item => item.provider === selected.value));
const plaintext = computed(() => selected.value === 'custom' && /^http:\/\//iu.test(baseUrl.value.trim()));
const profileFieldsDirty = computed(() => Boolean(key.value)
	|| modelOverride.value !== (profile.value?.modelOverride ?? '')
	|| webSearch.value !== (profile.value?.webSearch ?? false)
	|| webSearchTimeLimitMinutes.value !== (profile.value?.webSearchTimeLimitMinutes ?? AI_WEB_SEARCH_DEFAULT_TIME_LIMIT_MINUTES)
	|| (selected.value === 'custom' && (baseUrl.value !== (profile.value?.baseUrl ?? '')
		|| protocol.value !== (profile.value?.protocol ?? 'chat-completions')
		|| chatJsonMode.value !== (profile.value?.chatJsonMode ?? 'json_object'))));
const dirty = computed(() => Boolean(status.value) && (
	profileFieldsDirty.value || (selected.value !== status.value?.activeProvider
		&& (Boolean(profile.value?.hasKey) || (selected.value === 'custom'
			&& Boolean(profile.value?.baseUrl && profile.value.effectiveModel))))
));
const valid = computed(() => {
	if (selected.value === 'custom') {
		return Boolean(modelOverride.value.trim()) && Boolean(baseUrl.value.trim())
			&& (!plaintext.value || allowInsecureHttp.value);
	}
	return Boolean(key.value.trim()) || Boolean(profile.value?.hasKey);
});
watch(dirty, value => emit('dirty', value), { immediate: true });
watch(saving, value => emit('saving', value), { immediate: true });
/** Copy redacted saved preferences into the draft for the selected provider. */
function loadProfile(): void {
	const saved = profile.value;
	key.value = '';
	modelOverride.value = saved?.modelOverride ?? '';
	webSearch.value = saved?.webSearch ?? false;
	webSearchTimeLimitMinutes.value = saved?.webSearchTimeLimitMinutes ?? AI_WEB_SEARCH_DEFAULT_TIME_LIMIT_MINUTES;
	baseUrl.value = saved?.baseUrl ?? '';
	protocol.value = saved?.protocol ?? 'chat-completions';
	chatJsonMode.value = saved?.chatJsonMode ?? 'json_object';
	allowInsecureHttp.value = false;
}

/** Load Settings with an explicit initial and failed state. */
async function load(): Promise<void> {
	loading.value = true;
	try {
		status.value = await api.aiSettings();
		selected.value = status.value.activeProvider ?? 'openai';
		loadProfile();
		error.value = '';
	}
	catch (cause) {
		error.value = errorMessage(cause);
	}
	finally {
		loading.value = false;
	}
}

/** Switch between separately saved provider preferences. */
async function selectProvider(event: Event): Promise<void> {
	const control = event.target as HTMLSelectElement;
	const next = control.value as AiProvider;
	control.value = selected.value;
	if (profileFieldsDirty.value && !await requestConfirmation({
		key: 'discard-ai-provider-draft', title: 'Discard Provider Changes?',
		message: 'Switching providers will discard unsaved changes to this provider.',
		confirmLabel: 'Discard Changes', cancelLabel: 'Keep Editing', destructive: true,
	})) {
		return;
	}
	selected.value = next;
	loadProfile();
}

/** Check and activate the selected provider profile. */
async function save(): Promise<void> {
	if (!status.value || saving.value) {
		return;
	}
	saving.value = true;
	error.value = '';
	try {
		const body: AiSettingsSave = { activeProvider: selected.value, profile: {
			provider: selected.value,
			...(key.value ? { apiKey: key.value } : {}),
			modelOverride: modelOverride.value.trim() || null,
			webSearch: webSearch.value,
			webSearchTimeLimitMinutes: webSearchTimeLimitMinutes.value,
			...(selected.value === 'custom' ? { baseUrl: baseUrl.value.trim(), protocol: protocol.value,
				chatJsonMode: chatJsonMode.value, allowInsecureHttp: allowInsecureHttp.value } : {}),
		} };
		status.value = await api.saveAiSettings(body);
		loadProfile();
		emit('saved', 'AI provider saved.');
	}
	catch (cause) {
		error.value = errorMessage(cause);
	}
	finally {
		saving.value = false;
	}
}

/** Disable new AI generations without removing saved provider credentials. */
async function disable(): Promise<void> {
	if (!status.value || saving.value) {
		return;
	}
	saving.value = true;
	error.value = '';
	try {
		status.value = await api.saveAiSettings({ activeProvider: null });
		emit('saved', 'AI disabled. Saved keys were retained.');
	}
	catch (cause) {
		error.value = errorMessage(cause);
	}
	finally {
		saving.value = false;
	}
}

/** Explicitly delete the selected provider's saved credential. */
async function forgetKey(): Promise<void> {
	if (!status.value || saving.value) {
		return;
	}
	const provider = selected.value;
	const label = providers.find(item => item.id === provider)?.label ?? provider;
	if (!(await requestConfirmation({
		key: 'forget-ai-provider-key', title: 'Forget Provider Key?',
		message: `Forget the saved ${label} API key? You will need to enter it again to use this provider.`,
		confirmLabel: 'Forget Key', cancelLabel: 'Keep Key', destructive: true,
	})) || saving.value || selected.value !== provider) {
		return;
	}
	saving.value = true;
	error.value = '';
	try {
		status.value = await api.forgetAiKey(provider);
		key.value = '';
		emit('saved', 'Provider key forgotten.');
	}
	catch (cause) {
		error.value = errorMessage(cause);
	}
	finally {
		saving.value = false;
	}
}

onMounted(() => void load());
</script>

<template>
	<section class="panel form-grid span-2 ai-settings-panel" aria-labelledby="ai-settings-heading">
		<div class="span-2">
			<p class="eyebrow">Content selection</p>
			<h2 id="ai-settings-heading">AI provider</h2>
			<p>Choose a provider and enter its API key. Provider charges and results vary by model.</p>
		</div>
		<LoadingState v-if="loading" class="span-2" label="Loading AI settings…" />
		<div v-else-if="!status" class="span-2">
			<p class="notice error" role="alert">{{ error }}</p>
			<button type="button" class="button secondary" @click="load">Retry AI Settings</button>
		</div>
		<template v-else>
			<p v-if="!status.activeProvider" class="span-2">AI is off. Saving a provider enables it.</p>
			<label><span>Provider</span><select :value="selected" :disabled="saving" @change="selectProvider"><option v-for="provider in providers" :key="provider.id" :value="provider.id">{{ provider.label }}</option></select></label>
			<label><span>API Key {{ selected === 'custom' ? '(optional)' : '' }}</span><input v-model="key" type="password" autocomplete="off" :disabled="saving" :placeholder="profile?.keyPlaceholder ?? 'Enter API Key'" /><small v-if="profile?.hasKey">A key is saved for this provider. Enter a new key to replace it.</small></label>
			<p class="span-2">{{ modelOverride ? 'Custom model' : 'Recommended model' }}: <strong>{{ modelOverride || profile?.effectiveModel || 'Enter a model ID' }}</strong></p>
			<details class="span-2 ai-settings-advanced">
				<summary>Advanced</summary>
				<div class="form-grid">
					<label><span>Custom model ID</span><input v-model="modelOverride" :disabled="saving" placeholder="Use recommended model" /></label>
					<template v-if="selected === 'custom'">
						<label><span>Endpoint base URL</span><input v-model="baseUrl" type="url" :disabled="saving" placeholder="https://example.com/v1" /></label>
						<label><span>API format</span><select v-model="protocol" :disabled="saving"><option value="chat-completions">Chat Completions</option><option value="anthropic-messages">Anthropic Messages</option></select></label>
						<label v-if="protocol === 'chat-completions'"><span>JSON mode</span><select v-model="chatJsonMode" :disabled="saving"><option value="json_object">JSON object</option><option value="json_schema">JSON schema</option><option value="prompt_only">Prompt only</option></select></label>
						<label v-if="plaintext" class="settings-toggle span-2"><input v-model="allowInsecureHttp" type="checkbox" :disabled="saving" />I understand that HTTP sends the prompt and API key without encryption.</label>
					</template>
					<label v-if="profile?.researchAvailable" class="settings-toggle span-2"><input v-model="webSearch" type="checkbox" :disabled="saving" /><span>Use web research when generating<small class="ai-settings-research-note">May take longer, but can verify uncertain matches for a more accurate selection.</small></span></label>
					<label v-if="webSearch"><span>Web research time limit</span><select v-model.number="webSearchTimeLimitMinutes" :disabled="saving"><option :value="5">5 minutes</option><option :value="7">7 minutes</option><option :value="10">10 minutes</option><option :value="15">15 minutes</option></select><small>No new searches start after three minutes. This limit lets work already running finish.</small></label>
				</div>
			</details>
			<p v-if="status.connectionWarning" class="notice warning span-2" role="status">{{ status.connectionWarning }}</p>
			<p v-if="error" class="notice error span-2" role="alert">{{ error }}</p>
			<div class="form-actions span-2">
				<button v-if="profile?.hasKey" type="button" class="button secondary" :disabled="saving" @click="forgetKey">Forget key</button>
				<button v-if="status.activeProvider" type="button" class="button secondary" :disabled="saving" @click="disable">Disable AI</button>
				<button type="button" class="button" :disabled="saving || !dirty || !valid" @click="save">{{ saving ? 'Checking…' : 'Save AI Settings' }}</button>
			</div>
		</template>
	</section>
</template>
