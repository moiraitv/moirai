<script setup lang="ts">
import { useId } from 'vue';

defineProps<{
	label: string;
	message: string;
}>();

const tooltipId = useId();
</script>

<template>
	<span
		class="disabled-action-hint"
		role="group"
		tabindex="0"
		:aria-label="label"
		aria-disabled="true"
		:aria-describedby="tooltipId"
	>
		<slot />
		<span :id="tooltipId" class="disabled-action-tooltip" role="tooltip">
			{{ message }}
		</span>
	</span>
</template>
