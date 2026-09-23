<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch, type ComponentPublicInstance } from 'vue';
import { useVirtualizer } from '@tanstack/vue-virtual';
import { Ellipsis } from '@lucide/vue';
import type { SchedulingProgram, SchedulingProgramStatus } from '@moirai/shared';
import { useRoute } from 'vue-router';
import ActionMenu from '../ActionMenu.vue';
import ProgramThumbnails from './ProgramThumbnails.vue';
import { programDefinition, programTypeLabel, programUnavailableTooltip } from './program-catalog';
const props = defineProps<{ programs: SchedulingProgram[]; allPrograms: Map<string, SchedulingProgram>; statuses: Map<string, SchedulingProgramStatus>; usages: Map<string, number>; selected: string }>();
const emit = defineEmits<{ select: [id: string]; delete: [program: SchedulingProgram] }>();
const route = useRoute();
const scroll = ref<HTMLElement>();
const heading = ref<HTMLElement>();
const headingHeight = ref(0);
let headingObserver: ResizeObserver | undefined;
/** Reserve enough visible space for the two resource actions and their popover padding. */
const programActionsSpace = 150;
onMounted(() => {
	headingObserver = new ResizeObserver(() => {
		headingHeight.value = heading.value?.offsetHeight ?? 0;
	});
	if (heading.value) {
		headingObserver.observe(heading.value);
	}
});
onUnmounted(() => headingObserver?.disconnect());
const virtualizer = useVirtualizer(computed(() => ({ count: props.programs.length, getScrollElement: () => scroll.value ?? null, estimateSize: () => 80, getItemKey: (index: number) => props.programs[index]!.id, overscan: 5, scrollMargin: headingHeight.value, scrollPaddingStart: headingHeight.value })));
const rows = computed(() => virtualizer.value.getVirtualItems());
/** Measure each mounted virtual row after responsive text and columns settle. */
function measureRow(element: Element | ComponentPublicInstance | null): void {
	if (element instanceof HTMLElement) {
		virtualizer.value.measureElement(element);
	}
}
/** Navigate beyond the rendered window without changing the selected Program. */
function navigateRows(event: KeyboardEvent, index: number): void {
	const targets: Record<string, number> = { ArrowDown: index + 1, ArrowUp: index - 1, Home: 0, End: props.programs.length - 1 };
	const target = targets[event.key];
	if (target === undefined) {
		return;
	}
	event.preventDefault();
	const program = props.programs[Math.max(0, Math.min(props.programs.length - 1, target))];
	if (program) {
		void focusProgram(program.id);
	}
}
/** Return focus to a selected row even when virtualization has removed its old element. */
async function focusProgram(id: string): Promise<void> {
	const index = props.programs.findIndex(program => program.id === id);
	if (index < 0) {
		scroll.value?.focus();
		return;
	}
	virtualizer.value.scrollToIndex(index, { align: 'auto' });
	await nextTick();
	requestAnimationFrame(() => scroll.value?.querySelector<HTMLButtonElement>(`[data-program-id="${id}"]`)?.focus({ preventScroll: true }));
}
watch(() => props.programs.map(program => program.id).join(','), () => {
	if (scroll.value) {
		scroll.value.scrollTop = 0;
	}
});
defineExpose({ focusProgram });
</script>
<template>
	<div ref="scroll" class="program-management-list" tabindex="-1" aria-label="Programs list">
		<div ref="heading" class="program-management-columns" aria-hidden="true"><span>Program / Definition</span><span>Preview</span><span>Items</span><span>References</span><span></span></div>
		<div role="list" :style="{ height: `${virtualizer.getTotalSize()}px`, position: 'relative' }">
			<article v-for="row in rows" :key="String(row.key)" :ref="measureRow" :data-index="row.index" :aria-posinset="row.index + 1" :aria-setsize="programs.length" role="listitem" class="program-management-row" :class="{ selected: selected === programs[row.index]!.id }" :style="{ transform: `translateY(${row.start - headingHeight}px)` }" @click="($event.target as Element).closest('button, a') ? undefined : emit('select', programs[row.index]!.id)">
				<button class="program-management-identity" :aria-label="programs[row.index]!.name" :aria-description="statuses.get(programs[row.index]!.id)?.health" :data-program-id="programs[row.index]!.id" :aria-pressed="selected === programs[row.index]!.id" @keydown="navigateRows($event, row.index)" @click="emit('select', programs[row.index]!.id)">
					<strong><span class="status-dot" :class="`health-${statuses.get(programs[row.index]!.id)?.health ?? 'unknown'}`" :title="statuses.get(programs[row.index]!.id)?.health"></span>{{ programs[row.index]!.name }}</strong>
					<span><b class="program-type-badge" :class="`type-${programs[row.index]!.config.type}`">{{ programTypeLabel(programs[row.index]!.config.type) }}</b><span v-if="programs[row.index]!.config.type === 'content'" class="program-subtype-badge">{{ programDefinition(programs[row.index]!, allPrograms) }}</span><template v-else> {{ programDefinition(programs[row.index]!, allPrograms) }}</template></span>
				</button>
				<ProgramThumbnails :items="statuses.get(programs[row.index]!.id)?.previewItems ?? []" />
				<span class="program-management-count" :title="programUnavailableTooltip(statuses.get(programs[row.index]!.id))">{{ statuses.get(programs[row.index]!.id)?.previewPending ? 'Preparing…' : statuses.get(programs[row.index]!.id)?.indexedItemCount ?? '—' }}</span>
				<span class="program-management-usage">{{ usages.get(programs[row.index]!.id) ?? 0 }}<small> references</small></span>
				<ActionMenu :menu-class="row.start - (virtualizer.scrollOffset ?? 0) > (virtualizer.scrollRect?.height ?? 0) - programActionsSpace ? 'program-actions-above' : ''" :label="`Actions for ${programs[row.index]!.name}`"><template #trigger><Ellipsis :size="18" /></template><RouterLink :to="{ path: `/schedules/programs/${programs[row.index]!.id}`, query: route.query }">Edit Program</RouterLink><button type="button" @click="emit('delete', programs[row.index]!)">Delete Program</button></ActionMenu>
			</article>
		</div>
	</div>
</template>
