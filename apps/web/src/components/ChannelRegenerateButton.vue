<script setup lang="ts">
import { ref } from 'vue';
import { CalendarCog } from '@lucide/vue';
import type { Channel } from '@moirai/shared';
import { api } from '../api';
import { requestConfirmation } from '../confirmation';
import { errorMessage } from '../error-message';
import TransientToast from './TransientToast.vue';

const props = defineProps<{ channel: Channel; disabled?: boolean }>();
const emit = defineEmits<{ completed: []; error: [message: string] }>();
const busy = ref(false);
const message = ref('');

/** Confirm discarding generated history and rebuilding this channel from its saved schedule. */
async function regenerate(): Promise<void> {
	if (busy.value || props.disabled) {
		return;
	}

	const channel = props.channel;
	const confirmed = await requestConfirmation({
		key: `regenerate-channel-${channel.id}`,
		title: 'Regenerate Schedule?',
		message: `Discard all generated programming and scheduling history for ${channel.name} and start over? Active playback will restart.`,
		confirmLabel: 'Regenerate Schedule',
		destructive: true,
	});
	if (!confirmed) {
		return;
	}

	busy.value = true;
	message.value = '';
	emit('error', '');
	try {
		const status = await api.regenerateChannelSchedule(channel.id);
		if (status?.health === 'failed') {
			throw new Error(status.lastError ?? 'Schedule regeneration failed.');
		}
		message.value = status?.health === 'ready'
			? `Schedule regenerated for ${channel.name}.`
			: `Schedule regeneration queued for ${channel.name}.`;
		emit('completed');
	}
	catch (cause) {
		emit('error', `Could not regenerate the schedule for ${channel.name}: ${errorMessage(cause)}`);
	}
	finally {
		busy.value = false;
	}
}
</script>

<template>
	<button
		type="button"
		class="icon-button guide-channel-regenerate"
		:aria-label="`Regenerate schedule for ${channel.name}`"
		:title="disabled ? 'Assign a schedule before regenerating' : busy ? 'Regenerating schedule…' : `Regenerate schedule for ${channel.name}`"
		:disabled="disabled || busy"
		:aria-busy="busy"
		@click.stop="regenerate"
	>
		<CalendarCog :size="18" aria-hidden="true" />
	</button>
	<TransientToast v-if="message" :message="message" @close="message = ''" />
</template>
