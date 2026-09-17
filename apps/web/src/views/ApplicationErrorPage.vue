<script setup lang="ts">
import { CircleAlert } from '@lucide/vue';
import { useRouter } from 'vue-router';
import { applicationError, clearApplicationError } from '../application-error';
import ResourceEmptyState from '../components/ResourceEmptyState.vue';

const router = useRouter();

/** Leave the error page and open Status without keeping the failed view mounted. */
function goToStatus(): void {
	clearApplicationError();
	void router.replace('/');
}

/** Reload the management app to recover from a stuck render failure. */
function reload(): void {
	window.location.reload();
}
</script>

<template>
	<section>
		<ResourceEmptyState
			title="Internal Server Error"
			description="500 Internal Server Error"
		>
			<template #icon><CircleAlert :size="37" /></template>
			<button class="button" type="button" @click="reload">Reload</button>
			<button class="button secondary" type="button" @click="goToStatus">Go to Status</button>
			<template v-if="applicationError" #secondary>{{ applicationError }}</template>
		</ResourceEmptyState>
	</section>
</template>
