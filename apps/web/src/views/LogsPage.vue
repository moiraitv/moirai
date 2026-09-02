<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { ChevronDown, ChevronRight, Download, FileText, Pause, Play, RefreshCw, Search } from '@lucide/vue';
import type { LogLevel } from '@moirai/shared';
import type { CondensedLogEntry } from '../log-entry-context';
import LogEntryDetailsModal from '../components/LogEntryDetailsModal.vue';
import AnimatedDisclosure from '../components/AnimatedDisclosure.vue';
import LoadingState from '../components/LoadingState.vue';
import PageHeader from '../components/PageHeader.vue';
import { condenseRequestLogs, logRequestDetails } from '../log-entry-context';
import { requestDurationLabel } from '../log-format';
import { useLogsStore } from '../stores/logs';
import { countLabel } from '../count-label';

const store = useLogsStore();
const {
	entries,
	files,
	loading,
	loaded,
	loadingMore,
	error,
	nextCursor,
	scanLimitReached,
	activeLevel,
	activeSearch,
} = storeToRefs(store);
const level = ref<LogLevel | ''>(activeLevel.value);
const search = ref(activeSearch.value);
const autoRefresh = ref(true);
const selectedEntry = ref<CondensedLogEntry | null>(null);
const retainedFilesOpen = ref(false);
let filterTimer: ReturnType<typeof setTimeout> | undefined;
let refreshTimer: ReturnType<typeof setInterval> | undefined;
let selectedTrigger: HTMLElement | null = null;

const currentFile = computed(() => files.value.find((file) => file.active) ?? files.value[0]);
const retainedBytes = computed(() => files.value.reduce((total, file) => total + file.size, 0));
/** Visible rows with request lifecycle records paired before rendering. */
const displayEntries = computed(() =>
	condenseRequestLogs(entries.value).map((record) => ({
		...record,
		request: logRequestDetails(record.entry.context),
	})));

/** Format a full log timestamp in the viewer's locale. */
function formatTime(value: string): string {
	return new Intl.DateTimeFormat(undefined, {
		dateStyle: 'medium',
		timeStyle: 'medium',
	}).format(new Date(value));
}

/** Format a shorter timestamp while retaining date and second precision. */
function formatCompactTime(value: string): string {
	return new Intl.DateTimeFormat(undefined, {
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
	}).format(new Date(value));
}

/** Format retained log size using compact binary units. */
function formatBytes(value: number): string {
	if (value < 1024) {
		return `${value} B`;
	}

	if (value < 1024 * 1024) {
		return `${(value / 1024).toFixed(1)} KiB`;
	}

	return `${(value / 1024 / 1024).toFixed(1)} MiB`;
}

/** Open a stable snapshot of one log entry without interrupting live refresh. */
function openEntry(entry: CondensedLogEntry, event: MouseEvent): void {
	selectedTrigger = event.currentTarget as HTMLElement;
	selectedEntry.value = entry;
}

/** Close log details and return keyboard focus to the originating row when possible. */
function closeEntry(): void {
	selectedEntry.value = null;
	void nextTick(() => {
		if (selectedTrigger?.isConnected) {
			selectedTrigger.focus();
		}
		selectedTrigger = null;
	});
}

/** Reload logs with the active level and search filters. */
function refresh(): void {
	void store.load(level.value, search.value.trim()).catch(() => undefined);
}

watch([level, search], () => {
	if (filterTimer) {
		clearTimeout(filterTimer);
	}
	filterTimer = setTimeout(refresh, 350);
});

onMounted(() => {
	if (!loaded.value) {
		refresh();
	}
	refreshTimer = setInterval(() => {
		if (autoRefresh.value && document.visibilityState === 'visible') {
			refresh();
		}
	}, 5_000);
});

onBeforeUnmount(() => {
	if (filterTimer) {
		clearTimeout(filterTimer);
	}
	if (refreshTimer) {
		clearInterval(refreshTimer);
	}
});
</script>

<template>
	<section class="logs-page">
		<PageHeader
			eyebrow="Operational diagnostics"
			title="Logs"
			description="Inspect retained structured server activity and errors."
		>
			<template #actions>
				<button class="button secondary" type="button" @click="autoRefresh = !autoRefresh">
					<Pause v-if="autoRefresh" :size="17" />
					<Play v-else :size="17" />
					{{ autoRefresh ? 'Pause Live Refresh' : 'Resume Live Refresh' }}
				</button>
				<button class="button secondary" type="button" :disabled="loading" @click="refresh">
					<RefreshCw :size="17" :class="{ spinning: loading }" />Refresh
				</button>
			</template>
		</PageHeader>

		<p v-if="error" class="notice error">{{ error }}</p>
		<LoadingState v-if="loading && !loaded" label="Loading server logs…" />
		<div v-else class="async-state-surface">
			<div class="logs-toolbar panel">
				<label class="logs-search">
					<Search :size="18" />
					<input v-model="search" type="search" maxlength="200" placeholder="Search messages and context…" />
				</label>
				<label>
					<span class="visually-hidden">Log level</span>
					<select v-model="level">
						<option value="">All levels</option>
						<option value="trace">Trace</option>
						<option value="debug">Debug</option>
						<option value="info">Info</option>
						<option value="warn">Warning</option>
						<option value="error">Error</option>
						<option value="fatal">Fatal</option>
					</select>
				</label>
				<a
					v-if="currentFile"
					class="button secondary"
					:href="`/api/v1/logs/files/${encodeURIComponent(currentFile.name)}`"
					download
				>
					<Download :size="17" />Download Current
				</a>
			</div>

			<div v-if="entries.length" class="logs-list panel" :aria-busy="loading">
				<button
					v-for="row in displayEntries"
					:key="row.entry.id"
					class="log-entry"
					type="button"
					aria-haspopup="dialog"
					@click="openEntry(row, $event)"
				>
					<span class="log-level" :class="`level-${row.entry.level}`">{{ row.entry.level }}</span>
					<time class="log-entry-time log-entry-time-full" :datetime="row.entry.time">{{ formatTime(row.entry.time) }}</time>
					<time class="log-entry-time log-entry-time-compact" :datetime="row.entry.time">{{ formatCompactTime(row.entry.time) }}</time>
					<span class="log-entry-endpoint" :title="row.request.endpoint ?? 'No request endpoint'">
						<small v-if="row.request.method">{{ row.request.method }}</small>
						<code>{{ row.request.endpoint ?? '—' }}</code>
					</span>
					<span class="log-entry-result">
						<small v-if="row.completion?.statusCode">{{ row.completion.statusCode }}</small>
						<span v-if="row.request.method || row.completion">
							{{ requestDurationLabel(row.completion?.durationMs ?? null, 'compact') }}
						</span>
						<span v-else>—</span>
					</span>
					<strong class="log-entry-message" :title="row.entry.message || 'Structured log entry'">
						{{ row.entry.message || 'Structured log entry' }}
					</strong>
					<code class="log-entry-source" :title="row.request.sourceIp ?? 'No source IP'">
						{{ row.request.sourceIp ?? '—' }}
					</code>
					<code v-if="row.entry.requestId" class="log-entry-request">{{ row.entry.requestId }}</code>
					<span v-else class="log-entry-request" aria-hidden="true">—</span>
					<ChevronRight class="log-entry-disclosure" :size="16" aria-hidden="true" />
				</button>
			</div>
			<div v-else class="empty-state panel">
				<FileText :size="32" />
				<h3>No matching log entries</h3>
				<p>{{ files.length ? 'Adjust the current filters.' : 'No on-disk logs have been written yet.' }}</p>
			</div>

			<p v-if="scanLimitReached" class="notice">
				This page reached the bounded disk-scan limit. Continue to search older retained files.
			</p>
			<div v-if="nextCursor" class="logs-load-more">
				<button class="button secondary" type="button" :disabled="loadingMore" @click="store.loadMore">
					{{ loadingMore ? 'Loading…' : 'Load Older Entries' }}
				</button>
			</div>

			<AnimatedDisclosure v-if="files.length" v-model="retainedFilesOpen" class="log-files panel">
				<template #summary><span class="log-files-summary">
					<span>
						<FileText :size="18" />
						<strong>Retained files</strong>
						<small>{{ countLabel(files.length, 'file') }} · {{ formatBytes(retainedBytes) }}</small>
					</span>
					<ChevronDown :size="18" />
				</span></template>
				<div class="log-file-list">
					<a
						v-for="file in files"
						:key="file.name"
						:href="`/api/v1/logs/files/${encodeURIComponent(file.name)}`"
						download
					>
						<FileText :size="17" />
						<span><strong>{{ file.name }}</strong><small>{{ formatBytes(file.size) }}</small></span>
						<Download :size="16" />
					</a>
				</div>
			</AnimatedDisclosure>
		</div>

		<LogEntryDetailsModal
			v-if="selectedEntry"
			:entry="selectedEntry.entry"
			:completion="selectedEntry.completion"
			@close="closeEntry"
		/>
	</section>
</template>
