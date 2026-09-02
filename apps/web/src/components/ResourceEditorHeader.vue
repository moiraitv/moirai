<script setup lang="ts">
import { X } from '@lucide/vue';

defineProps<{
	closeLabel: string;
	disabled?: boolean;
}>();

const emit = defineEmits<{ close: [] }>();
</script>

<template>
	<header class="resource-editor-header">
		<div class="resource-editor-heading-copy">
			<slot />
		</div>
		<button
			type="button"
			class="icon-button resource-editor-close"
			:aria-label="closeLabel"
			:disabled="disabled"
			@click="emit('close')"
		>
			<X :size="21" aria-hidden="true" />
		</button>
	</header>
</template>
