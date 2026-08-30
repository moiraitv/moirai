<script setup lang="ts">
import type { ProgramItemAdditionResult } from '@moirai/shared';

defineProps<{ result: ProgramItemAdditionResult }>();
defineEmits<{ close: [] }>();
</script>

<template>
	<div class="program-addition-toast" role="status">
		<span v-if="result.addedItemCount === 0"><strong>Already selected</strong> in {{ result.program.name }}</span>
		<span v-else><strong>{{ result.addedItemCount }} added</strong> to {{ result.program.name }}<small v-if="result.alreadySelectedCount"> · {{ result.alreadySelectedCount }} already selected</small></span>
		<RouterLink :to="`/schedules/programs/${result.program.id}`">Edit program</RouterLink>
		<button type="button" aria-label="Dismiss" @click="$emit('close')">×</button>
	</div>
</template>
