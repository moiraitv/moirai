import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import type { DataConflictReport, PlaybackEngineStatus } from '@moirai/shared';
import { api } from '../api';
import { errorMessage } from '../error-message';
import { isTransientReadFailure } from '../read-recovery';

/** Consecutive failed reads before cached playback status needs a persistent warning. */
export const PLAYBACK_FAILURE_LIMIT = 3;

/** Keep independent playback and conflict state, retaining cached data during bounded recovery. */
export const useDashboardStore = defineStore('dashboard', () => {
	const playback = ref<PlaybackEngineStatus | null>(null);
	const conflictReport = ref<DataConflictReport | null>(null);
	const loading = ref(true);
	const loaded = computed(() => playback.value !== null && conflictReport.value !== null);
	const error = ref('');
	const playbackError = ref('');
	const playbackFailures = ref(0);
	const playbackTransient = ref(false);
	const playbackUpdatedAt = ref<string | null>(null);
	const playbackRefreshing = ref(false);
	const playbackRecovering = computed(() => Boolean(playback.value && playbackError.value)
		&& playbackTransient.value && playbackFailures.value < PLAYBACK_FAILURE_LIMIT);
	let loadSequence = 0;
	let pendingPlayback: Promise<void> | undefined;

	/** Load conflicts independently so a playback success cannot erase an unrelated failure. */
	async function load(): Promise<void> {
		const sequence = ++loadSequence;
		if (!loaded.value) {
			loading.value = true;
		}
		await Promise.all([
			refreshPlayback(),
			api.dataConflicts().then((result) => {
				if (sequence === loadSequence) {
					conflictReport.value = result;
					error.value = '';
				}
			}).catch((cause) => {
				if (sequence === loadSequence) {
					error.value = errorMessage(cause);
				}
			}),
		]);
		if (sequence === loadSequence) {
			loading.value = false;
		}
	}

	/** Coalesce polling and live events into one read, preserving the last successful status. */
	function refreshPlayback(): Promise<void> {
		if (pendingPlayback) {
			return pendingPlayback;
		}
		playbackRefreshing.value = true;
		pendingPlayback = api.playbackStatus().then((result) => {
			playback.value = result;
			playbackUpdatedAt.value = new Date().toISOString();
			playbackError.value = '';
			playbackFailures.value = 0;
			playbackTransient.value = false;
		}).catch((cause) => {
			playbackError.value = errorMessage(cause);
			playbackFailures.value++;
			playbackTransient.value = isTransientReadFailure(cause);
		}).finally(() => {
			pendingPlayback = undefined;
			playbackRefreshing.value = false;
		});
		return pendingPlayback;
	}

	return { playback, conflictReport, loading, loaded, error, load, refreshPlayback,
		playbackError, playbackUpdatedAt, playbackRecovering, playbackRefreshing };
});
