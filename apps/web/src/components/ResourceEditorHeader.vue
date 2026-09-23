<script setup lang="ts">
import { useId } from 'vue';
import { X } from '@lucide/vue';

defineProps<{
	closeLabel: string;
	disabled?: boolean;
}>();

const emit = defineEmits<{ close: [] }>();
const usageSlotId = useId();
</script>

<template>
	<header class="resource-editor-header">
		<div class="resource-editor-heading-copy">
			<slot />
		</div>
		<div class="resource-editor-header-trailing">
			<div :id="usageSlotId" class="resource-editor-usage-slot"><slot name="actions" /></div>
			<button
				type="button"
				class="icon-button resource-editor-close"
				:aria-label="closeLabel"
				:disabled="disabled"
				@click="emit('close')"
			>
				<X :size="21" aria-hidden="true" />
			</button>
		</div>
	</header>
</template>
