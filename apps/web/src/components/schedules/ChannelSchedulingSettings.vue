<script setup lang="ts">
import { ref, useId } from 'vue';
import { ChevronDown } from '@lucide/vue';
import FormDisclosure from '../FormDisclosure.vue';

defineProps<{ disabled?: boolean }>();

const enabled = defineModel<boolean | undefined>();
const open = ref(false);
const helpId = useId();
</script>

<template>
	<FormDisclosure v-model:open="open" class="channel-scheduling-settings">
		<template #summary><strong>Advanced scheduling</strong><ChevronDown class="form-disclosure-chevron" :size="20" aria-hidden="true" /></template>
		<label class="channel-duplicate-toggle">
			<input type="checkbox" :disabled="disabled" :checked="enabled !== false" :aria-describedby="helpId" @change="enabled = ($event.target as HTMLInputElement).checked" />
			<span>Avoid simultaneous duplicates on other channels</span>
		</label>
		<p :id="helpId" class="field-hint">Prefer different items for Shuffle, Random, Weighted random, Similar Items, and Theme programs when the same item is scheduled on another channel. Sequential programs always retain their configured order.</p>
	</FormDisclosure>
</template>
