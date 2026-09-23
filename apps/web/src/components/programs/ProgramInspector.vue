<script setup lang="ts">
import { X, Trash2 } from '@lucide/vue';
import { useRoute } from 'vue-router';
import type { SchedulingProgram, SchedulingProgramStatus } from '@moirai/shared';
import ResourceUsage from '../ResourceUsage.vue';
import TwoStepActionButton from '../TwoStepActionButton.vue';
import SimilarItemsPreview from './SimilarItemsPreview.vue';
import { programDetailComponent } from './program-inspector-registry';
import { contentSubtype, contentSubtypeLabels, programTypeLabel, programValueLabel } from './program-catalog';
defineProps<{ program: SchedulingProgram; programs: Map<string, SchedulingProgram>; status?: SchedulingProgramStatus | undefined; libraries: { id: string; name: string }[]; modal: boolean; actionError?: string; deleting?: boolean }>();
const emit = defineEmits<{ close: []; select: [id: string]; delete: [program: SchedulingProgram]; refresh: [] }>();
const route = useRoute();
</script>
<template>
	<aside v-modal-focus="{ active: modal, escape: () => emit('close') }" class="program-inspector" :role="modal ? 'dialog' : 'region'" :aria-modal="modal || undefined" aria-labelledby="program-inspector-title" @keydown.esc="!modal && emit('close')">
		<header><div><h2 id="program-inspector-title">{{ program.name }}</h2><span class="program-type-badge" :class="`type-${program.config.type}`">{{ programTypeLabel(program.config.type) }}</span><span v-if="program.config.type === 'content'" class="program-subtype-badge">{{ contentSubtypeLabels[contentSubtype(program)] }}</span></div><button type="button" class="icon-button" aria-label="Close program inspector" @click="emit('close')"><X :size="20" /></button></header>
		<div class="program-inspector-content">
			<p v-if="actionError" class="notice error" role="alert">{{ actionError }}</p>
			<p v-if="status" class="program-inspector-health"><span class="status-dot" :class="`health-${status.health}`"></span>{{ programValueLabel(status.health) }} · {{ status.availableItemCount }}/{{ status.indexedItemCount }} available</p>
			<SimilarItemsPreview v-if="status && program.config.type !== 'sequence'" :items="status.previewItems" :heading="['similarity', 'theme'].includes(program.config.type) ? 'Sample matches' : 'Media preview'" :matching-count="status.matchingItemCount" :requested-count="status.requestedItemCount" :loading="Boolean(status.previewPending)" :message="status.health !== 'ready' ? status.sourceLabel : undefined" empty-message="No preview items available." />
			<component :is="programDetailComponent(program.config.type)" v-if="programDetailComponent(program.config.type)" :program="program" :programs="programs" :status="status" :libraries="libraries" @select="emit('select', $event)" @refresh="emit('refresh')" />
			<p v-else>{{ status?.sourceLabel ?? 'Open the editor to inspect this Program definition.' }}</p>
			<ResourceUsage kind="program" :resource-id="program.id" :revision="Date.parse(program.updatedAt)" inline />
			<p class="muted">Updated {{ new Date(program.updatedAt).toLocaleString() }}</p>
		</div>
		<footer><RouterLink class="button" :to="{ path: `/schedules/programs/${program.id}`, query: route.query }">Edit Program</RouterLink><TwoStepActionButton :key="program.id" class="icon-button danger-icon" label="Delete Program" confirm-label="Confirm Delete Program" :disabled="deleting" @confirm="emit('delete', program)"><Trash2 :size="18" /></TwoStepActionButton></footer>
	</aside>
</template>
