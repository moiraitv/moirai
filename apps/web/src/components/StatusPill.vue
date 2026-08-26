<script setup lang="ts">
defineProps<{ value: string }>();
</script>
<template>
	<span class="status-pill" :data-status="value">{{ value.replace('-', ' ') }}</span>
</template>
