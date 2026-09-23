<script setup lang="ts">
import type { SchedulingProgramPreviewItem } from '@moirai/shared';
import { FileText } from '@lucide/vue';
import { artworkVariantUrl } from '../../artwork-url';
import { hideBrokenImage } from '../../image-error';
defineProps<{ items: SchedulingProgramPreviewItem[] }>();
</script>
<template>
	<span class="program-mini-preview" aria-hidden="true"><span v-for="item in items.slice(0, 6)" :key="item.id" :title="item.title"><img v-if="item.artworkUrl" :src="artworkVariantUrl(item.artworkUrl, 'thumb')" alt="" loading="lazy" @error="hideBrokenImage" /><FileText v-else :size="16" /></span></span>
</template>
