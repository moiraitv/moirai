<script setup lang="ts">
import type { ProgramItemAdditionResult } from '@moirai/shared';
import TransientToast from '../TransientToast.vue';

defineProps<{ result: ProgramItemAdditionResult }>();
defineEmits<{ close: [] }>();
</script>

<template>
	<TransientToast :duration="8000" @close="$emit('close')">
		<span v-if="result.addedItemCount === 0"><strong>Already selected</strong> in {{ result.program.name }}</span>
		<span v-else><strong>{{ result.addedItemCount }} added</strong> to {{ result.program.name }}<small v-if="result.alreadySelectedCount"> · {{ result.alreadySelectedCount }} already selected</small></span>
		<RouterLink :to="`/schedules/programs/${result.program.id}`">Edit Program</RouterLink>
	</TransientToast>
</template>
