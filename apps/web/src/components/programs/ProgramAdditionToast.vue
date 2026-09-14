<script setup lang="ts">
import { computed } from 'vue';
import type { ProgramItemAdditionResult, ProgramGroupAdditionResult } from '@moirai/shared';
import TransientToast from '../TransientToast.vue';

const props = defineProps<{ result: ProgramItemAdditionResult | ProgramGroupAdditionResult }>();
const addedCount = computed(() => 'addedGroupCount' in props.result ? props.result.addedGroupCount : props.result.addedItemCount);
defineEmits<{ close: [] }>();
</script>

<template>
	<TransientToast :duration="8000" @close="$emit('close')">
		<span v-if="addedCount === 0"><strong>Already selected</strong> in {{ result.program.name }}</span>
		<span v-else><strong>{{ addedCount }} added</strong> to {{ result.program.name }}<small v-if="result.alreadySelectedCount"> · {{ result.alreadySelectedCount }} already selected</small></span>
		<RouterLink :to="`/schedules/programs/${result.program.id}`">Edit Program</RouterLink>
	</TransientToast>
</template>
