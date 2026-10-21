<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router';
import { useDraftProtection } from '../draft-protection';
import { requestConfirmation } from '../confirmation';
import PageHeader from '../components/PageHeader.vue';
import SettingsTabs from '../components/SettingsTabs.vue';
import PlaybackSettingsPanel from '../components/PlaybackSettingsPanel.vue';
import AiSettingsPanel from '../components/AiSettingsPanel.vue';
import BackupSettingsPanel from '../components/BackupSettingsPanel.vue';
import TransientToast from '../components/TransientToast.vue';

const route = useRoute();
const router = useRouter();
const activeTab = computed({
	get: () => String(route.params.section),
	set: (section: string) => {
		void router.push({ path: `/settings/${section}`, query: route.query, hash: route.hash });
	},
});
const dirty = reactive({ playback: false, ai: false, backups: false });
const saving = reactive({ playback: false, ai: false, backups: false });
const attention = reactive({ playback: false, ai: false, backups: false });
const message = ref('');
const restoring = ref(false);
const sections = computed(() => [
	{ id: 'playback', label: 'Playback', dirty: dirty.playback, attention: attention.playback, to: { path: '/settings/playback', query: route.query, hash: route.hash } },
	{ id: 'ai', label: 'AI', dirty: dirty.ai, attention: attention.ai, to: { path: '/settings/ai', query: route.query, hash: route.hash } },
	{ id: 'backups', label: 'Backups', dirty: dirty.backups, attention: attention.backups, to: { path: '/settings/backups', query: route.query, hash: route.hash } },
]);
const unsavedSections = computed(() => sections.value.filter(section => section.dirty).map(section => section.label));
const busy = computed(() => Object.values(saving).some(Boolean));
useDraftProtection(() => !restoring.value && unsavedSections.value.length > 0);
onBeforeRouteLeave(async () => !busy.value && (!unsavedSections.value.length || await requestConfirmation({
	key: 'discard-settings', title: 'Discard Unsaved Changes?',
	message: `Leave without saving changes to ${unsavedSections.value.join(', ')}?`,
	confirmLabel: 'Discard Changes', cancelLabel: 'Keep Editing', destructive: true,
})));

/** Protect drafts in every tab before restoring saved configuration. */
async function beforeRestore(): Promise<boolean> {
	if (saving.playback || saving.ai) {
		return false;
	}
	return !unsavedSections.value.length || await requestConfirmation({
		title: 'Discard Unsaved Settings?', message: `Restoring will discard changes to ${unsavedSections.value.join(', ')}. Continue with the restore?`,
		confirmLabel: 'Continue', destructive: true,
	});
}
</script>

<template>
	<section class="settings-page">
		<PageHeader hide-help eyebrow="Application settings" title="Settings" description="Manage playback, content selection, and backups." />
		<SettingsTabs v-model="activeTab" :sections="sections">
			<template #playback><PlaybackSettingsPanel @dirty="dirty.playback = $event" @saving="saving.playback = $event" @attention="attention.playback = $event" @saved="message = $event" /></template>
			<template #ai><AiSettingsPanel @dirty="dirty.ai = $event" @saving="saving.ai = $event" @attention="attention.ai = $event" @saved="message = $event" /></template>
			<template #backups><BackupSettingsPanel :before-restore="beforeRestore" @dirty="dirty.backups = $event" @saving="saving.backups = $event" @attention="attention.backups = $event" @restoring="restoring = true" @saved="message = $event" /></template>
		</SettingsTabs>
		<TransientToast v-if="message" :message="message" @close="message = ''" />
	</section>
</template>
