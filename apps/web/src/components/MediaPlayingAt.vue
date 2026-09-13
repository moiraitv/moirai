<script setup lang="ts">
import { ref, watch, onBeforeUnmount } from 'vue';
import { CalendarDays, RefreshCw } from '@lucide/vue';
import type { MediaAirings } from '@moirai/shared';
import { api } from '../api';
import { errorMessage } from '../error-message';
import { instantLabel } from '../time-format';
import LoadingState from './LoadingState.vue';

const props = defineProps<{ resourceId: string }>();
const result = ref<MediaAirings>();
const page = ref(1);
const loading = ref(true);
const error = ref('');
let sequence = 0;
/** Fetch already-realized showings, ignoring responses for an item that has been left. */
async function load(): Promise<void> {
	const request = ++sequence;
	loading.value = true;
	error.value = '';
	try {
		const value = await api.mediaAirings(props.resourceId, page.value);
		if (request === sequence) {
			result.value = value;
		}
	}
	catch (cause) {
		if (request === sequence) {
			error.value = errorMessage(cause);
		}
	}
	finally {
		if (request === sequence) {
			loading.value = false;
		}
	}
}
/** Restart at the first upcoming showing when explicitly refreshing. */
function refresh(): void {
	page.value = 1;
	void load();
}
/** Show both endpoints with a date so overnight showings remain unambiguous in local time. */
function timeLabel(value: string): string {
	return instantLabel(value, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
}
watch(() => props.resourceId, () => {
	page.value = 1;
	void load(); 
}, { immediate: true });
onBeforeUnmount(() => {
	sequence++; 
});
</script>

<template>
	<section class="media-playing-at" aria-label="Playing at">
		<h3>
			<CalendarDays :size="20" aria-hidden="true" />Playing at
			<button class="media-playing-at-refresh" type="button" aria-label="Refresh showings" title="Refresh showings" :disabled="loading" @click="refresh">
				<RefreshCw :size="18" aria-hidden="true" />
			</button>
		</h3>
		<LoadingState v-if="loading" label="Loading scheduled showings…" />
		<div v-else-if="error"><p class="notice error" role="alert">{{ error }}</p><button class="button secondary" @click="load">Retry showings</button></div>
		<template v-else-if="result">
			<p v-if="!result.total">Not currently showing</p>
			<ul v-else>
				<li v-for="showing in result.items" :key="showing.id" class="media-airing">
					<RouterLink :to="`/schedules/channels/${showing.channelId}`">{{ showing.channelNumber }} · {{ showing.channelName }}</RouterLink>
					<time :datetime="showing.startsAt">{{ timeLabel(showing.startsAt) }}</time>
					<span>until <time :datetime="showing.finishesAt">{{ timeLabel(showing.finishesAt) }}</time></span>
				</li>
			</ul>
			<div v-if="result.total > 20" class="form-actions"><button class="button secondary" :disabled="page === 1" @click="page--; load()">Earlier</button><span>{{ page }} / {{ Math.ceil(result.total / 20) }}</span><button class="button secondary" :disabled="page * 20 >= result.total" @click="page++; load()">Later</button></div>
			<p v-if="result.total" class="muted">Already-realized showings, in your local time. Schedules may change.</p>
		</template>
	</section>
</template>
