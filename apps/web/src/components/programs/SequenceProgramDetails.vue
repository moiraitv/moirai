<script setup lang="ts">
import type { SchedulingProgram } from '@moirai/shared';
defineProps<{ program: SchedulingProgram; programs: Map<string, SchedulingProgram> }>();
const emit = defineEmits<{ select: [id: string] }>();
</script>
<template>
	<section v-if="program.config.type === 'sequence'" class="program-inspector-section">
		<h3>Source Programs</h3>
		<ol class="program-source-list"><li v-for="entry in program.config.entries" :key="entry.id"><button v-if="programs.has(entry.programId)" type="button" class="button secondary" @click="emit('select', entry.programId)">{{ programs.get(entry.programId)?.name }}</button><span v-else>Missing Program</span><small>{{ entry.count }} {{ entry.count === 1 ? 'item' : 'items' }}</small></li></ol>
		<p>{{ program.config.repeat ? 'Repeats the sequence in configured order.' : 'Plays the sequence once in configured order.' }}</p>
	</section>
</template>
