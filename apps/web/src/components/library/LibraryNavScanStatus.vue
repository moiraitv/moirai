<script setup lang="ts">
import { computed } from 'vue';
import { CircleAlert, Minus, RefreshCw, Unplug } from '@lucide/vue';
import type { Library } from '@moirai/shared';
import { libraryScanStatus } from '../../library-health';

const props = defineProps<{ library: Library }>();
const status = computed(() => libraryScanStatus(props.library));
const icon = computed(() => {
	if (status.value === 'Scanning') {
		return RefreshCw;
	}
	if (status.value === 'Offline') {
		return Unplug;
	}
	if (status.value === 'Warnings') {
		return CircleAlert;
	}
	return Minus;
});
</script>

<template>
	<span class="library-nav-scan-status" :data-status="status" role="img" :aria-label="`Scan status: ${status}`" :title="`Scan status: ${status}`">
		<span v-if="status === 'Idle'" class="library-nav-idle-dot" aria-hidden="true"></span>
		<component :is="icon" v-else :size="15" aria-hidden="true" />
	</span>
</template>
