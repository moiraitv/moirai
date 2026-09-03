<script setup lang="ts">
import { ChevronRight, Monitor } from '@lucide/vue';
import type { Channel } from '@moirai/shared';

defineProps<{ channels: Channel[] }>();
</script>

<template>
	<section class="assignment-panel editor-surface">
		<div class="template-panel-heading">
			<div><p class="eyebrow">Channel usage</p><h2>This template is used on</h2></div>
		</div>
		<div v-if="channels.length" class="assigned-channel-grid">
			<RouterLink
				v-for="channel in channels"
				:key="channel.id"
				class="assigned-channel-card"
				:to="`/schedules/channels/${channel.id}`"
				:aria-label="`Manage schedule for channel ${channel.number}, ${channel.name}`"
			>
				<div class="assigned-channel-icon"><Monitor :size="24" /></div>
				<div><strong>{{ channel.number }} · {{ channel.name }}</strong></div>
				<ChevronRight class="assigned-channel-chevron" :size="20" aria-hidden="true" />
			</RouterLink>
		</div>
		<div v-else class="template-usage-empty">NOT CURRENTLY IN USE</div>
	</section>
</template>
