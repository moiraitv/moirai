<script setup lang="ts">
import { Dices, ListOrdered, Shuffle, Sparkles } from '@lucide/vue';

/** Selection strategies currently supported by content programs. */
type SelectionStrategy = 'sequential' | 'shuffle' | 'random' | 'weighted-random';

defineProps<{ modelValue: SelectionStrategy; seed: string }>();
const emit = defineEmits<{ 'update:modelValue': [value: SelectionStrategy]; 'update:seed': [value: string] }>();

/** Update the optional deterministic seed from the text field. */
function updateSeed(event: Event): void {
	emit('update:seed', (event.target as HTMLInputElement).value);
}
</script>

<template>
	<section class="program-editor-section">
		<div class="program-section-heading"><span>2</span><strong>Selection</strong></div>
		<p class="program-section-description">Choose how items are selected from the source.</p>
		<div class="strategy-card-grid">
			<button v-for="strategy in [{ id: 'sequential', label: 'Sequential', detail: 'Play in order, continuing where you left off', icon: ListOrdered }, { id: 'shuffle', label: 'Shuffle (no repeats)', detail: 'Random order with no repeats until all have played', icon: Shuffle }, { id: 'random', label: 'Random', detail: 'Choose a random item each time', icon: Dices }, { id: 'weighted-random', label: 'Weighted random', detail: 'Prefer content your viewers have chosen while retaining variety', icon: Sparkles }] as const" :key="strategy.id" type="button" :class="{ active: modelValue === strategy.id }" :aria-pressed="modelValue === strategy.id" @click="emit('update:modelValue', strategy.id)">
				<component :is="strategy.icon" :size="29" /><strong>{{ strategy.label }}</strong><span>{{ strategy.detail }}</span>
			</button>
		</div>
		<label v-if="modelValue !== 'sequential'" class="strategy-seed-field"><span>Stable seed</span><input :value="seed" placeholder="Optional deterministic seed" @input="updateSeed" /></label>
		<div class="program-playback-state"><label><span>Playback state</span><select disabled><option>Configured per schedule slot</option></select></label><p>Choose persistent or occurrence-based continuity when attaching this program to a schedule slot.</p></div>
	</section>
</template>
