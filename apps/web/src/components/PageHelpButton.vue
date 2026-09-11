<script setup lang="ts">
import { CircleHelp } from '@lucide/vue';
import { useRoute } from 'vue-router';
import { helpTopicForPath, helpTopicIds, openHelp } from '../help';

defineProps<{ label: string; topicId?: typeof helpTopicIds[number] }>();
const route = useRoute();
</script>

<template>
	<button type="button" class="page-help-button" :aria-label="`Help with ${label}`" :title="`Help with ${label}`" @click="openHelp(topicId ?? helpTopicForPath(route.path))">
		<CircleHelp :size="20" />
	</button>
</template>
