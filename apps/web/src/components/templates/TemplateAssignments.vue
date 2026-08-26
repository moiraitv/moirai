<script setup lang="ts">
import { Monitor } from '@lucide/vue';
import type { Channel } from '@moirai/shared';

defineProps<{ channels: Channel[] }>();
</script>

<template>
	<section class="assignment-panel editor-surface">
		<div class="template-panel-heading">
			<div><p class="eyebrow">Channel usage</p><h2>This template is used on</h2></div>
		</div>
		<div v-if="channels.length" class="assigned-channel-grid">
			<article v-for="channel in channels" :key="channel.id">
				<div class="assigned-channel-icon"><Monitor :size="24" /></div>
				<div><strong>{{ channel.number }} · {{ channel.name }}</strong></div>
				<RouterLink :to="`/schedules/channels/${channel.id}`">Manage</RouterLink>
			</article>
		</div>
		<div v-else class="template-usage-empty">NOT CURRENTLY IN USE</div>
	</section>
</template>
