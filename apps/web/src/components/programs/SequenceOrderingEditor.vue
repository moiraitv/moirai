<script setup lang="ts">
import { ListOrdered, Shuffle, Dices, Rows3 } from '@lucide/vue';
import type { SequenceOrdering } from '@moirai/shared';
defineProps<{ modelValue: SequenceOrdering['type']; seed: string }>();
const emit = defineEmits<{ 'update:modelValue': [value: SequenceOrdering['type']]; 'update:seed': [value: string] }>();

/** Parent ordering choices leave each child Program's media selection unchanged. */
const modes = [
	{ id: 'ordered', label: 'Ordered', detail: 'Play each step’s selections together, in the listed order.', icon: ListOrdered },
	{ id: 'shuffled-blocks', label: 'Shuffled blocks', detail: 'Shuffle the steps each cycle, keeping each step’s selections together.', icon: Shuffle },
	{ id: 'shuffled-allocations', label: 'Shuffled allocations', detail: 'Mix selections across steps while keeping each step’s count.', icon: Dices },
	{ id: 'balanced-rotation', label: 'Balanced rotation', detail: 'Spread each step’s selections through the cycle, avoiding consecutive turns when possible.', icon: Rows3 },
] as const;
</script>

<template>
	<section class="program-editor-section">
		<div class="program-section-heading">
			<span>2</span>
			<div class="program-section-heading-copy"><strong>Ordering</strong><p class="program-section-description">Choose how the sequence takes selections from its steps.</p></div>
		</div>
		<div class="strategy-card-grid">
			<button v-for="mode in modes" :key="mode.id" type="button" :class="{ active: modelValue === mode.id }" :aria-pressed="modelValue === mode.id" @click="emit('update:modelValue', mode.id)">
				<component :is="mode.icon" :size="29" /><strong>{{ mode.label }}</strong><span>{{ mode.detail }}</span>
			</button>
		</div>
		<label v-if="modelValue === 'shuffled-blocks' || modelValue === 'shuffled-allocations'" class="strategy-seed-field"><span>Stable seed</span><input :value="seed" placeholder="Optional deterministic seed" @input="emit('update:seed', ($event.target as HTMLInputElement).value)" /></label>
		<div class="program-playback-state">
			<div class="program-playback-state-summary"><strong>Playback state</strong><span>Configured in template schedule slots</span></div>
			<p>Choose “Continue persistently” or “Restart each day” under Advanced scheduling behavior for each slot that uses this program.</p>
		</div>
	</section>
</template>
