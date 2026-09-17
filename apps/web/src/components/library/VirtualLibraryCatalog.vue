<script setup lang="ts">
import type { MediaGroup, ProgramGroupAddition, ProgramItemAddition } from '@moirai/shared';
import { useWindowVirtualizer } from '@tanstack/vue-virtual';
import { computed, nextTick, watch, type ComponentPublicInstance } from 'vue';
import {
	catalogCardColumnGap,
	catalogVirtualAnchorPositions,
	type CatalogVirtualRow,
} from '../../catalog-virtualization';
import LibraryMediaCard from './LibraryMediaCard.vue';

const props = defineProps<{
	rows: CatalogVirtualRow[];
	catalogWidth: number;
	columnCount: number;
	scrollMargin: number;
	scrollPadding: number;
	selectionMode: boolean;
	selectionKind: 'items' | 'groups';
	selectedItemIds: Set<string>;
	libraryId: string;
	libraryType: string;
}>();

const emit = defineEmits<{
	enter: [group: MediaGroup];
	toggle: [itemId: string];
	add: [selection: ProgramItemAddition['selection'] | ProgramGroupAddition['selection']];
}>();

/** Estimate one row until TanStack Virtual can measure its rendered height. */
function estimateRow(index: number): number {
	const row = props.rows[index];
	if (row?.kind === 'heading') {
		return 36;
	}

	const cardWidth
		= (
			Math.max(0, props.catalogWidth)
			- catalogCardColumnGap * Math.max(0, props.columnCount - 1)
		) / Math.max(1, props.columnCount);
	const matchHeight = row?.cards.some(card => card.entry.matches?.some(match => match.field !== 'title')) ? 28 : 0;
	return Math.max(240, cardWidth * 1.5 + 51) + matchHeight;
}

const virtualizer = useWindowVirtualizer<HTMLElement>(computed(() => ({
	count: props.rows.length,
	estimateSize: estimateRow,
	getItemKey: (index: number) => props.rows[index]?.key ?? index,
	gap: 13,
	overscan: 2,
	scrollMargin: props.scrollMargin,
	scrollPaddingStart: props.scrollPadding + 4,
})));
const virtualRows = computed(() => virtualizer.value.getVirtualItems());
const totalHeight = computed(() => virtualizer.value.getTotalSize());

/** Register a rendered row so its exact responsive height replaces the estimate. */
function measureRow(element: Element | ComponentPublicInstance | null): void {
	const resolved
		= element instanceof HTMLElement
			? element
			: element && '$el' in element
				? (element.$el as unknown)
				: null;
	if (resolved instanceof HTMLElement) {
		virtualizer.value.measureElement(resolved);
	}
}

/** Scroll one virtual row below the sticky controls using the caller's requested motion. */
function scrollToRow(index: number, behavior: 'auto' | 'smooth' = 'auto'): void {
	virtualizer.value.scrollToIndex(index, { align: 'start', behavior });
	requestAnimationFrame(() => requestAnimationFrame(() => {
		// Correct estimates after the destination and its overscan rows have been measured.
		virtualizer.value.scrollToIndex(index, { align: 'start', behavior });
	}));
}

/** Return viewport positions for every catalog anchor, including unmounted rows. */
function anchorPositions(scrollTop: number): Array<{ key: string; top: number }> {
	return catalogVirtualAnchorPositions(
		props.rows,
		virtualizer.value.measurementsCache.map((measurement) => measurement.start),
		scrollTop,
	);
}

watch([() => props.catalogWidth, () => props.columnCount], async () => {
	await nextTick();
	virtualizer.value.measure();
});

defineExpose({ anchorPositions, scrollToRow });
</script>

<template>
	<div
		class="virtual-media-grid"
		:class="{ 'selection-mode': selectionMode }"
		:style="{ height: `${totalHeight}px` }"
	>
		<div
			v-for="virtualRow in virtualRows"
			:key="String(virtualRow.key)"
			:ref="measureRow"
			class="virtual-media-row"
			:class="`virtual-media-${rows[virtualRow.index]!.kind}-row`"
			:data-index="virtualRow.index"
			:style="{ transform: `translateY(${virtualRow.start - scrollMargin}px)` }"
		>
			<span
				v-for="anchorKey in rows[virtualRow.index]!.anchorKeys"
				:key="anchorKey"
				class="virtual-catalog-anchor"
				:data-catalog-anchor="anchorKey"
			></span>
			<h2 v-if="rows[virtualRow.index]!.kind === 'heading'" class="genre-heading">
				{{ rows[virtualRow.index]!.label }}
			</h2>
			<div
				v-else
				class="media-grid virtual-media-card-grid"
				:style="{ gridTemplateColumns: `repeat(${columnCount}, minmax(0, 1fr))` }"
			>
				<LibraryMediaCard
					v-for="card in rows[virtualRow.index]!.cards"
					:key="card.entry.key"
					class="media-card"
					:entry="card.entry"
					:library-id="libraryId"
					:library-type="libraryType"
					:selection-mode="selectionMode"
					:selectable="selectionKind === 'groups' ? Boolean(card.entry.group) : Boolean(card.entry.item)"
					:selected="selectedItemIds.has(card.entry.item?.id ?? card.entry.group?.id ?? '')"
					@enter="emit('enter', $event)"
					@toggle="emit('toggle', $event)"
					@add="emit('add', $event)"
				/>
			</div>
		</div>
	</div>
</template>
