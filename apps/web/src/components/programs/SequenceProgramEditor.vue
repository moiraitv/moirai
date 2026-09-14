<script setup lang="ts">
import { ArrowDown, ArrowUp, Plus, Trash2 } from '@lucide/vue';
import type { SchedulingProgram } from '@moirai/shared';
import TwoStepActionButton from '../TwoStepActionButton.vue';

/** One counted program reference in a composite sequence. */
interface SequenceEntry {
	id: string;
	programId: string;
	count: number;
}

const props = defineProps<{ entries: SequenceEntry[]; programs: SchedulingProgram[]; editingId: string | null; repeat: boolean }>();
const emit = defineEmits<{ add: []; move: [index: number, direction: -1 | 1]; remove: [index: number]; 'update:entries': [entries: SequenceEntry[]]; 'update:repeat': [repeat: boolean] }>();

/** Update one sequence entry without mutating the parent's array in place. */
function updateEntry(index: number, update: Partial<SequenceEntry>): void {
	emit('update:entries', props.entries.map((entry, entryIndex) => entryIndex === index ? { ...entry, ...update } : entry));
}
</script>

<template>
	<section class="program-editor-section sequence-editor-section">
		<div class="program-section-heading">
			<span>1</span>
			<div class="program-section-heading-copy">
				<strong>Sequence steps</strong>
				<p class="program-section-description">Combine existing programs in a counted custom order.</p>
			</div>
		</div>
		<div class="program-sequence-panel">
			<div v-for="(entry, index) in entries" :key="entry.id" class="sequence-entry">
				<input :value="entry.count" type="number" inputmode="numeric" min="1" max="10000" @input="updateEntry(index, { count: Number(($event.target as HTMLInputElement).value) })" />
				<span>×</span>
				<select :value="entry.programId" @change="updateEntry(index, { programId: ($event.target as HTMLSelectElement).value })">
					<option v-for="program in programs.filter((candidate) => candidate.id !== editingId)" :key="program.id" :value="program.id">{{ program.name }}</option>
				</select>
				<button type="button" class="icon-button" @click="emit('move', index, -1)"><ArrowUp :size="15" /></button>
				<button type="button" class="icon-button" @click="emit('move', index, 1)"><ArrowDown :size="15" /></button>
				<TwoStepActionButton
					class="icon-button danger-icon"
					:label="`Remove sequence step ${index + 1}`"
					:confirm-label="`Confirm remove sequence step ${index + 1}`"
					@confirm="emit('remove', index)"
				>
					<Trash2 :size="15" />
				</TwoStepActionButton>
			</div>
			<button type="button" class="toolbar-button" @click="emit('add')"><Plus :size="16" />Add Step</button>
			<label class="check-row"><input :checked="repeat" type="checkbox" @change="emit('update:repeat', ($event.target as HTMLInputElement).checked)" />Repeat sequence</label>
		</div>
	</section>
</template>
