<script setup lang="ts">
import { PREVIEW_FILLER_STAGES } from '../../preview-filler';
</script>

<template>
	<span class="preview-filler-legend" aria-label="Filler tick legend">
		<span v-for="stage in PREVIEW_FILLER_STAGES" :key="stage.kind" :title="stage.name">
			<i class="preview-filler-symbol" :class="`stage-${stage.kind}`" aria-hidden="true"></i>{{ stage.label }}
		</span>
	</span>
</template>
