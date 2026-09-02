<script setup lang="ts">
defineProps<{ visible: boolean; followingSpace?: boolean }>();
</script>

<template>
	<Transition name="help-panel">
		<div
			v-if="visible"
			class="animated-help-panel"
			:class="{ 'with-following-space': followingSpace }"
		>
			<div class="animated-help-panel-content">
				<slot />
			</div>
		</div>
	</Transition>
</template>
