<script setup lang="ts">
import { CalendarClock, Clock3, Database, Download, FileArchive, Files, HardDrive, Settings2, Trash2, Upload, ArrowDown, ArrowUp, X } from '@lucide/vue';
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import { backupFilename, backupSettingsSchema, type BackupInfo, type BackupReview, type BackupStatus } from '@moirai/shared';
import { backupCategory as category, backupCreatedDate as formatDate, backupSize as formatSize } from '../backup-format';
import BackupRestoreModal from './BackupRestoreModal.vue';
import { backupApi } from '../backup-api';
import { errorMessage } from '../error-message';
import { requestConfirmation } from '../confirmation';
import LoadingState from './LoadingState.vue';
import FormDisclosure from './FormDisclosure.vue';
import { ChevronDown } from '@lucide/vue';
import SettingsSaveFooter from './SettingsSaveFooter.vue';
import PageHelpButton from './PageHelpButton.vue';

const props = defineProps<{ beforeRestore: () => Promise<boolean> }>();
const emit = defineEmits<{ dirty: [value: boolean]; saving: [value: boolean]; saved: [message: string]; restoring: []; attention: [value: boolean] }>();
const status = ref<BackupStatus | null>(null);
const loading = ref(true);
const loadError = ref('');
const actionError = ref('');
const working = ref('');
const restarting = ref(false);
const draft = reactive(backupSettingsSchema.parse({}));
const review = ref<BackupReview | null>(null);
const reviewOpen = ref(false);
const validationPending = ref(false);
const validationError = ref('');
const validationName = ref('');
const restoreStarted = ref(false);
let reviewGeneration = 0;
let reviewOpener: HTMLElement | null = null;
const fileInput = ref<HTMLInputElement | null>(null);
const dirty = computed(() => status.value !== null && JSON.stringify(draft) !== JSON.stringify(status.value.settings));
const disabled = computed(() => Boolean(working.value || status.value?.busy || restarting.value));
const newestFirst = ref(true);
const automaticOpen = ref(false);
const sortedBackups = computed(() => [...(status.value?.backups ?? [])].sort((a, b) => newestFirst.value ? b.createdAt.localeCompare(a.createdAt) : a.createdAt.localeCompare(b.createdAt)));
const valid = computed(() => backupSettingsSchema.safeParse(draft).success);
let poll: ReturnType<typeof setInterval> | undefined;
let refreshing = false;
let disposed = false;

watch(dirty, value => emit('dirty', value));
watch(working, value => emit('saving', Boolean(value)));

watch(() => Boolean(loadError.value || actionError.value || validationError.value || status.value?.error || status.value?.damagedBackups?.length), value => emit('attention', value), { immediate: true });

/** Load explicit collection state while preserving an unsaved policy draft during polling. */
async function load(): Promise<void> {
	if (refreshing || restarting.value) {
		return;
	}
	refreshing = true;
	try {
		const wasDirty = dirty.value;
		const originalDraft = JSON.stringify(draft);
		const next = await backupApi.status();
		status.value = next;
		if (!wasDirty && JSON.stringify(draft) === originalDraft) {
			Object.assign(draft, next.settings);
		}
		loadError.value = '';
	}
	catch (cause) {
		loadError.value = errorMessage(cause);
	}
	finally {
		loading.value = false;
		refreshing = false;
	}
}
/** Serialize panel actions, retaining failures in context and successes in the shared toast. */
async function perform(label: string, action: () => Promise<void>): Promise<void> {
	if (disabled.value) {
		return;
	}
	working.value = label;
	actionError.value = '';
	try {
		await action();
	}
	catch (cause) {
		actionError.value = errorMessage(cause);
	}
	finally {
		working.value = '';
		await load();
	}
}
/** Save only a valid changed policy; independent archive categories retain their own limits. */
async function save(): Promise<void> {
	if (!status.value || !dirty.value || !valid.value) {
		return;
	}

	await perform('Saving backup settings…', async () => {
		const saved = await backupApi.save(backupSettingsSchema.parse(draft));
		if (status.value) {
			status.value.settings = saved;
		}
		Object.assign(draft, saved);
		emit('saved', 'Backup settings saved.');
	});
}
/** Discard only this panel's policy draft after the compact confirmation. */
function reset(): void {
	if (status.value) {
		Object.assign(draft, status.value.settings);
	}
}
/** Persist dismissal so polling and page reloads do not bring the same warning back. */
async function dismissWarning(): Promise<void> {
	await perform('Dismissing backup warning…', () => backupApi.dismissWarning());
}
/** Create a retained manual archive without affecting the automatic schedule. */
async function create(): Promise<void> {
	await perform('Creating backup…', async () => {
		await backupApi.create();
		emit('saved', 'Manual backup created.');
	});
}
/** Confirm permanent removal of a named archive before starting deletion. */
async function remove(backup: { id: string; name: string }): Promise<void> {
	if (disabled.value || !await requestConfirmation({
		key: `delete-backup-${backup.id}`, title: 'Delete Backup?',
		message: `Permanently delete ${backup.name}? This backup cannot be recovered.`,
		confirmLabel: 'Delete Backup', cancelLabel: 'Keep Backup', destructive: true,
	})) {
		return;
	}
	await perform('Deleting backup…', async () => {
		await backupApi.delete(backup.id);
		emit('saved', 'Backup deleted.');
	});
}
/** Confirm intent before reading and validating a stored archive. */
async function inspect(backup: BackupInfo): Promise<void> {
	if (disabled.value) {
		return;
	}
	reviewOpener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
	if (!await requestConfirmation({
		title: 'Restore Backup?', message: `Validate ${backupFilename(backup)} from ${formatDate(backup.createdAt)} before reviewing its replacement summary? Current configuration will not change until you confirm Restore and Restart.`,
		confirmLabel: 'Validate Backup',
	})) {
		return;
	}
	await validate(backupFilename(backup), () => backupApi.review(backup.id));
}
/** Present validation immediately and ignore results from a review the user has closed. */
async function validate(name: string, request: () => Promise<BackupReview>): Promise<void> {
	if (disabled.value || disposed) {
		return;
	}
	const generation = ++reviewGeneration;
	review.value = null;
	validationName.value = name;
	validationError.value = '';
	validationPending.value = true;
	reviewOpen.value = true;
	await perform('Validating backup…', async () => {
		const progressPoll = setInterval(() => void load(), 1000);
		try {
			const result = await request();
			if (generation === reviewGeneration && !disposed) {
				review.value = result;
			}
		}
		catch (cause) {
			if (generation === reviewGeneration && !disposed) {
				validationError.value = errorMessage(cause);
			}
		}
		finally {
			clearInterval(progressPoll);
			if (generation === reviewGeneration) {
				validationPending.value = false;
			}
		}
	});
}
/** Abandon the review while an in-flight validation finishes without changing live resources. */
async function closeReview(): Promise<void> {
	if (restoreStarted.value || restarting.value) {
		return;
	}
	reviewGeneration += 1;
	reviewOpen.value = false;
	review.value = null;
	validationPending.value = false;
	validationError.value = '';
	// Let modal teardown finish its fallback focus before returning to the original row action.
	await nextTick();
	await nextTick();
	if (!disposed && !reviewOpen.value && reviewOpener?.isConnected && reviewOpener.getClientRects().length && !reviewOpener.hasAttribute('disabled')) {
		reviewOpener.focus({ preventScroll: true });
	}
}
/** Upload the selected ZIP into the same visible validation and replacement review. */
async function upload(event: Event): Promise<void> {
	const input = event.target as HTMLInputElement;
	const file = input.files?.[0];
	input.value = '';
	if (file) {
		reviewOpener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		await validate(file.name, () => backupApi.import(file));
	}
}
/** Protect Settings drafts before accepting the final dialog's replacement confirmation. */
async function restore(): Promise<void> {
	const selected = review.value;
	if (!selected || disabled.value || !await props.beforeRestore() || review.value?.id !== selected.id || !reviewOpen.value) {
		return;
	}
	restoreStarted.value = true;
	try {
		await perform('Preparing recovery backup and restore…', async () => {
			try {
				await backupApi.restore(selected.id);
				restarting.value = true;
				emit('restoring');
				void waitForRestart();
			}
			catch (cause) {
				validationError.value = errorMessage(cause);
			}
		});
	}
	finally {
		restoreStarted.value = false;
	}
}
/** Wait for the destination's old session to be invalidated, then reload into sign-in. */
async function waitForRestart(): Promise<void> {
	for (let attempt = 0; attempt < 300 && !disposed; attempt += 1) {
		await new Promise(resolve => setTimeout(resolve, 1000));
		try {
			const response = await fetch('/api/v1/backups', { cache: 'no-store' });
			if (response.status === 401) {
				window.location.reload();
				return;
			}
			const startup = await fetch('/api/v1/health/startup', { cache: 'no-store' });
			if (startup.ok && (await startup.json()).status === 'failed') {
				actionError.value = 'Restore needs attention. Check Moirai’s startup page and storage, then restart to retry.';
				return;
			}
		}
		catch {
			// The listener is briefly unavailable while service instances are replaced.
		}
	}
	actionError.value = 'Moirai is still restarting. Reload this page to check startup progress.';
}
/** Keep the next scheduled occurrence in the same timezone as the fixed run time. */
function formatScheduleDate(value: string): string {
	return new Date(value).toLocaleString(undefined, { timeZone: status.value?.timeZone });
}
onMounted(() => {
	void load();
	poll = setInterval(() => void load(), 5000);
});
onUnmounted(() => {
	disposed = true;
	reviewGeneration += 1;
	if (poll) {
		clearInterval(poll);
	}
});
</script>

<template>
	<form class="settings-tab-editor" novalidate @submit.prevent="save">
		<section class="panel backup-settings-panel" data-disclosure-layout aria-labelledby="backup-settings-heading">
			<header class="backup-intro">
				<div class="settings-card-title"><h2 id="backup-settings-heading">Backup &amp; Restore</h2><PageHelpButton label="Backup &amp; Restore" topic-id="settings.backups#backup-and-restore" /></div>
				<p>Save configuration, library IDs, channel icons, and uploaded assets. Library media, generated caches, and credentials are excluded.</p>
			</header>
			<LoadingState v-if="loading" label="Loading backups…" />
			<p v-if="loadError" class="notice error" role="alert">{{ loadError }} <button type="button" class="button secondary" @click="load">Retry Backups</button></p>
			<template v-if="status">
				<FormDisclosure v-model:open="automaticOpen" class="backup-automatic" data-disclosure-item>
					<template #header="{ expanded, contentId }">
						<div class="form-disclosure-trigger backup-automatic-header">
							<button type="button" class="settings-disclosure-handle" :aria-expanded="expanded" :aria-controls="contentId" aria-label="Toggle automatic backup details" @click="automaticOpen = !expanded"><ChevronDown :size="20" aria-hidden="true" /></button>
							<div class="backup-automatic-heading">
								<span class="settings-card-icon"><Settings2 :size="24" aria-hidden="true" /></span>
								<div class="backup-automatic-copy">
									<div class="settings-card-title">
										<h3 id="automatic-backup-heading"><button type="button" class="settings-disclosure-title" :aria-expanded="expanded" :aria-controls="contentId" aria-label="Automatic Backup" @click="automaticOpen = !expanded"><strong>Automatic Backup</strong></button></h3>
										<PageHelpButton label="Automatic Backup" topic-id="settings.backups#automatic-backup" />
									</div>
									<small>Configure automatic backups to protect your configuration.</small>
								</div>
							</div>
							<label class="backup-enable settings-enable">
								<input v-model="draft.enabled" type="checkbox" role="switch" :disabled="disabled" aria-label="Enable automatic backups" />
								<span class="channel-enabled-track" aria-hidden="true" />
								<span><strong>{{ draft.enabled ? 'Enabled' : 'Disabled' }}</strong></span>
							</label>
							<div class="settings-policy-summary backup-policy-summary" aria-label="Saved automatic backup policy">
								<template v-if="status.settings.enabled">
									<span class="backup-policy-item"><Clock3 :size="17" aria-hidden="true" /><span><strong>{{ status.settings.intervalDays === 1 ? 'Daily' : `Every ${status.settings.intervalDays} days` }} at 3:00 am</strong><small>{{ status.timeZone }}</small></span></span>
									<span class="backup-policy-item"><Files :size="17" aria-hidden="true" /><span><strong>Keep {{ status.settings.retention }} {{ status.settings.retention === 1 ? 'backup' : 'backups' }}</strong><small>Automatic backup retention</small></span></span>
								</template>
								<span v-else class="backup-policy-item"><Clock3 :size="17" aria-hidden="true" /><span>Automatic backups disabled</span></span>
								<span v-if="dirty" class="backup-policy-unsaved">Unsaved changes</span>
							</div>
						</div>
					</template>
					<div class="backup-automatic-content">
						<div class="form-grid backup-policy-fields">
							<label><span>Backup interval (days)</span><input v-model.number="draft.intervalDays" type="number" min="1" max="3650" step="1" :disabled="disabled" aria-describedby="backup-interval-help" /><small id="backup-interval-help">How often to create an automatic backup.</small></label>
							<label><span>Automatic backups to retain</span><input v-model.number="draft.retention" type="number" min="1" max="1000" step="1" :disabled="disabled" aria-describedby="backup-retention-help" /><small id="backup-retention-help">Number of automatic backups to keep. Oldest are automatically deleted.</small></label>
						</div>
						<div class="backup-details">
							<div class="backup-detail"><Clock3 :size="21" aria-hidden="true" /><div><strong>Schedule</strong><p>Automatic backups run at 3:00 am ({{ status.timeZone }}). Missed runs wait for the next scheduled time.</p></div></div>
							<div class="backup-detail"><CalendarClock :size="21" aria-hidden="true" /><div><strong>Next backup</strong><p>{{ status.nextRun ? formatScheduleDate(status.nextRun) : 'Automatic backups are disabled' }}<span v-if="status.nextRun" class="backup-detail-zone">({{ status.timeZone }})</span></p></div></div>
							<div class="backup-detail"><HardDrive :size="21" aria-hidden="true" /><div><strong>Storage location</strong><p><code>{{ status.directory }}</code></p></div></div>
							<div class="backup-detail"><Files :size="21" aria-hidden="true" /><div><strong>Other backup types</strong><p>Manual and pre-restore recovery backups stay until deleted. The newest 3 upgrade recovery backups are kept separately.</p></div></div>
						</div>
					</div>
				</FormDisclosure>
				<div v-if="status.error" class="notice warning backup-warning" role="alert"><span>{{ status.error }}</span><button type="button" class="icon-button" aria-label="Dismiss backup warning" :disabled="disabled" @click="dismissWarning"><X :size="18" aria-hidden="true" /></button></div>
				<section class="backup-section" data-disclosure-item aria-labelledby="manual-backup-heading">
					<header class="backup-section-title">
						<span class="settings-card-icon"><Database :size="24" aria-hidden="true" /></span>
						<div><div class="settings-card-title"><h3 id="manual-backup-heading">Backups</h3><PageHelpButton label="Backups" topic-id="settings.backups#backups" /></div><p>Create a backup of your current configuration, import a saved backup, or restore from a backup.</p></div>
					</header>
					<div class="form-actions">
						<button type="button" class="button" :disabled="disabled" @click="create"><Download :size="17" aria-hidden="true" />Create Backup</button>
						<button type="button" class="button secondary" :disabled="disabled" @click="fileInput?.click()"><Upload :size="17" aria-hidden="true" />Import Backup</button>
						<input ref="fileInput" class="backup-file-input" type="file" accept=".zip,application/zip" aria-label="Choose backup ZIP" @change="upload" />
					</div>
					<p v-if="working || status.busy || restarting" class="notice" role="status">{{ restarting ? 'Restoring configuration and restarting Moirai…' : working || status.busy }}</p>
					<div class="backup-table-scroll">
						<table class="backup-table" :class="{ 'has-backups': status.backups.length || status.damagedBackups?.length }" aria-label="Saved backups">
							<thead><tr><th scope="col">Name</th><th scope="col" :aria-sort="newestFirst ? 'descending' : 'ascending'"><button type="button" class="backup-sort" @click="newestFirst = !newestFirst">Created<component :is="newestFirst ? ArrowDown : ArrowUp" :size="13" aria-hidden="true" /></button></th><th scope="col">Type</th><th scope="col">Size</th><th scope="col">Actions</th></tr></thead>
							<tbody>
								<tr v-if="!status.backups.length && !status.damagedBackups?.length"><td colspan="5"><div class="backup-empty"><Database :size="30" aria-hidden="true" /><div><strong>No saved backups yet.</strong><p>Manual and automatic backups will appear here.</p></div></div></td></tr>
								<tr v-for="backup in sortedBackups" :key="backup.id">
									<td class="backup-name"><div class="backup-name-content"><FileArchive :size="18" aria-hidden="true" /><div><span :title="backupFilename(backup)">{{ backupFilename(backup) }}</span><small>Moirai {{ backup.applicationVersion }}</small></div></div></td>
									<td><time :datetime="backup.createdAt">{{ formatDate(backup.createdAt) }}</time></td>
									<td><span class="backup-kind" :data-kind="backup.kind">{{ category(backup.kind) }}</span></td>
									<td class="backup-size">{{ formatSize(backup.size) }}</td>
									<td><div class="form-actions backup-row-actions"><a class="button secondary" :href="`/api/v1/backups/${backup.id}/download`" download>Download</a><button type="button" class="button secondary" :disabled="disabled" @click="inspect(backup)">Restore</button><button type="button" class="icon-button backup-delete" :aria-label="`Delete backup ${backupFilename(backup)}`" :title="`Delete backup ${backupFilename(backup)}`" :disabled="disabled" @click="remove({ id: backup.id, name: backupFilename(backup) })"><Trash2 :size="18" aria-hidden="true" /></button></div></td>
								</tr>
								<tr v-for="backup in status.damagedBackups ?? []" :key="`damaged-${backup.id}`">
									<td class="backup-name"><div class="backup-name-content"><FileArchive :size="18" aria-hidden="true" /><div><span :title="backup.name">{{ backup.name }}</span><small>Unreadable backup</small></div></div></td>
									<td colspan="3"><p class="notice warning">This archive’s metadata could not be read. Other backups remain available. Delete it only if you no longer need it.</p></td>
									<td><button type="button" class="icon-button backup-delete" :aria-label="`Delete backup ${backup.name}`" :title="`Delete backup ${backup.name}`" :disabled="disabled" @click="remove(backup)"><Trash2 :size="18" aria-hidden="true" /></button></td>
								</tr>
							</tbody>
						</table>
					</div>
				</section>
			</template>
			<BackupRestoreModal v-if="reviewOpen" :review="review" :source-name="validationName" :validating="validationPending" :validation-progress="status?.busy?.startsWith('Validating backup:') ? status.busy : ''" :restoring="restoreStarted" :restarting="restarting" :busy="disabled" :error="validationError || (restarting ? actionError : '')" @close="closeReview" @restore="restore" />
			<p v-if="actionError" class="notice error" role="alert">{{ actionError }}</p>
		</section>
		<SettingsSaveFooter label="Backup" :dirty="dirty" :valid="valid" :busy="disabled" :saving="working === 'Saving backup settings…'" :ready="status !== null && !loading" @reset="reset" />
	</form>
</template>
