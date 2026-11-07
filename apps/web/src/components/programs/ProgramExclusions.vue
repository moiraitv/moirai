<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import type { ContentExclusions } from '@moirai/shared';
import ProgramExclusionsDrawer from './ProgramExclusionsDrawer.vue';

defineProps<{ libraryId: string; libraryType: string; libraryName: string; resultIds?: string[] | undefined; disabled?: boolean }>();
const exclusions = defineModel<ContentExclusions>({ required: true });
const emit = defineEmits<{ removeMissing: [id: string] }>();
const initialTab = ref<'browse' | 'results' | null>(null);
const count = computed(() => exclusions.value.itemIds.length + exclusions.value.groupIds.length);
let trigger: HTMLButtonElement | undefined;

/** Open the same drawer for library exclusions or for the AI Program's frozen results. */
function open(tab: 'browse' | 'results', event: MouseEvent): void {
	trigger = event.currentTarget as HTMLButtonElement;
	initialTab.value = tab;
}

/** Return focus to the Program after the nested drawer finishes closing. */
async function close(): Promise<void> {
	initialTab.value = null;
	await nextTick();
	trigger?.focus({ preventScroll: true });
}
</script>

<template>
	<div class="selected-collection-summary program-exclusions-summary">
		<div class="selected-collection-copy">
			<strong>Exclusions</strong>
			<small>{{ count ? `${count.toLocaleString()} ${count === 1 ? 'entry' : 'entries'}` : 'No exclusions' }}</small>
		</div>
		<div class="program-exclusions-actions">
			<button v-if="resultIds" type="button" class="toolbar-button" :disabled="!libraryId || disabled" @click="open('results', $event)">Review results</button>
			<button type="button" class="toolbar-button" :disabled="!libraryId || disabled" @click="open('browse', $event)">Manage exclusions</button>
		</div>
	</div>
	<ProgramExclusionsDrawer v-if="initialTab" :key="libraryId" v-model="exclusions" :result-ids="resultIds" :library-id="libraryId" :library-type="libraryType" :library-name="libraryName" :initial-tab="initialTab" @close="close" @remove-missing="emit('removeMissing', $event)" />
</template>
