<script setup lang="ts">
import { ArrowDown, ArrowUp, Plus, Trash2 } from '@lucide/vue';
import type { SchedulingProgram } from '@moirai/shared';
import TwoStepActionButton from '../TwoStepActionButton.vue';

import type { SequenceDraftEntry } from './program-draft';

const props = defineProps<{ entries: SequenceDraftEntry[]; programs: SchedulingProgram[]; editingId: string | null; repeat: boolean; chance: boolean }>();
const emit = defineEmits<{ add: []; move: [index: number, direction: -1 | 1]; remove: [index: number]; 'update:entries': [entries: SequenceDraftEntry[]]; 'update:repeat': [repeat: boolean] }>();

/** Update one sequence entry without mutating the parent's array in place. */
function updateEntry(index: number, update: Partial<SequenceDraftEntry>): void {
	emit('update:entries', props.entries.map((entry, entryIndex) => entryIndex === index ? { ...entry, ...update } : entry));
}
/** Preserve a blank number input in the draft without treating it as zero. */
function quantity(event: Event): number | '' {
	const value = (event.target as HTMLInputElement).valueAsNumber;
	return Number.isFinite(value) ? value : '';
}
</script>

<template>
	<section class="program-editor-section sequence-editor-section">
		<div class="program-section-heading">
			<span>1</span>
			<div class="program-section-heading-copy">
				<strong>Sequence steps</strong>
				<p class="program-section-description">{{ chance ? 'Set the chance (%) that each step plays one item per cycle.' : 'Combine existing programs in a counted custom order.' }}</p>
			</div>
		</div>
		<div class="program-sequence-panel">
			<div v-for="(entry, index) in entries" :key="entry.id" class="sequence-entry">
				<span class="sequence-entry-ordinal" :aria-label="`Step ${index + 1}`">{{ index + 1 }}</span>
				<div class="sequence-entry-fields">
					<div class="sequence-entry-selection">
						<input :aria-label="`Step ${index + 1} ${chance ? 'chance (%)' : 'count'}`" :value="chance ? entry.chance : entry.count" type="number" inputmode="numeric" :min="chance ? 0 : 1" :max="chance ? 100 : 10000" @input="updateEntry(index, { [chance ? 'chance' : 'count']: quantity($event) })" />
						<span aria-hidden="true">{{ chance ? '%' : '×' }}</span>
						<select :aria-label="`Step ${index + 1} Program`" :value="entry.programId" @change="updateEntry(index, { programId: ($event.target as HTMLSelectElement).value })">
							<option v-for="candidate in programs.filter((candidate) => candidate.id !== editingId)" :key="candidate.id" :value="candidate.id">{{ candidate.name }}</option>
						</select>
					</div>
				</div>
				<TwoStepActionButton
					class="icon-button danger-icon"
					:label="`Remove sequence step ${index + 1}`"
					:confirm-label="`Confirm remove sequence step ${index + 1}`"
					@confirm="emit('remove', index)"
				>
					<Trash2 :size="15" />
				</TwoStepActionButton>
				<div class="sequence-entry-order" role="group" :aria-label="`Order step ${index + 1}`">
					<button type="button" class="icon-button" :disabled="index === 0" :aria-label="`Move step ${index + 1} up`" @click="emit('move', index, -1)"><ArrowUp :size="16" aria-hidden="true" /></button>
					<button type="button" class="icon-button" :disabled="index === entries.length - 1" :aria-label="`Move step ${index + 1} down`" @click="emit('move', index, 1)"><ArrowDown :size="16" aria-hidden="true" /></button>
				</div>
			</div>
			<button type="button" class="toolbar-button" @click="emit('add')"><Plus :size="16" />Add Step</button>
			<label class="check">
				<input :checked="repeat" type="checkbox" @change="emit('update:repeat', ($event.target as HTMLInputElement).checked)" />
				<span>Repeat sequence</span>
			</label>
		</div>
	</section>
</template>
