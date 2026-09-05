<script setup lang="ts">
import { Dices, ListOrdered, Shuffle, Sparkles } from '@lucide/vue';

/** Selection strategies currently supported by content programs. */
type SelectionStrategy = 'sequential' | 'shuffle' | 'random' | 'weighted-random';

withDefaults(defineProps<{
	modelValue: SelectionStrategy;
	seed: string;
	showSeed?: boolean;
	showPlaybackState?: boolean;
}>(), {
	showSeed: true,
	showPlaybackState: true,
});
const emit = defineEmits<{ 'update:modelValue': [value: SelectionStrategy]; 'update:seed': [value: string] }>();

/** Update the optional deterministic seed from the text field. */
function updateSeed(event: Event): void {
	emit('update:seed', (event.target as HTMLInputElement).value);
}
</script>

<template>
	<section class="program-editor-section">
		<div class="program-section-heading">
			<span>2</span>
			<div class="program-section-heading-copy">
				<strong>Selection</strong>
				<p class="program-section-description">Choose how items are selected from the source.</p>
			</div>
		</div>
		<div class="strategy-card-grid">
			<button v-for="strategy in [{ id: 'sequential', label: 'Sequential', detail: 'Play in order, continuing where you left off', icon: ListOrdered }, { id: 'shuffle', label: 'Shuffle (no repeats)', detail: 'Random order with no repeats until all have played', icon: Shuffle }, { id: 'random', label: 'Random', detail: 'Choose a random item each time', icon: Dices }, { id: 'weighted-random', label: 'Weighted random', detail: 'Prefer content your viewers have chosen while retaining variety', icon: Sparkles }] as const" :key="strategy.id" type="button" :class="{ active: modelValue === strategy.id }" :aria-pressed="modelValue === strategy.id" @click="emit('update:modelValue', strategy.id)">
				<component :is="strategy.icon" :size="29" /><strong>{{ strategy.label }}</strong><span>{{ strategy.detail }}</span>
			</button>
		</div>
		<label v-if="showSeed && modelValue !== 'sequential'" class="strategy-seed-field"><span>Stable seed</span><input :value="seed" placeholder="Optional deterministic seed" @input="updateSeed" /></label>
		<div v-if="showPlaybackState" class="program-playback-state">
			<div class="program-playback-state-summary">
				<strong>Playback state</strong>
				<span>Configured in template schedule slots</span>
			</div>
			<p>Choose “Continue persistently” or “Restart each day” under Advanced scheduling behavior for each slot that uses this program.</p>
		</div>
	</section>
</template>
