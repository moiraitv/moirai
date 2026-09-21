import { defaultRangeExtractor, useWindowVirtualizer } from '@tanstack/vue-virtual';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, type ComponentPublicInstance, type Ref } from 'vue';
import type { ChannelGuideRow } from '../channel-groups';

/** Small lineups and embedded previews keep their complete natural tab order. */
const COMPLETE_ROW_LIMIT = 12;

/** Virtualize measured guide rows in page flow while retaining the focused channel. */
export function useGuideRows(rows: Ref<ChannelGuideRow[]>, ready: Ref<boolean>) {
	const body = ref<HTMLElement>();
	const margin = ref(0);
	const focusedKey = ref<string | null>(null);
	let observer: ResizeObserver | undefined;
	const virtualizer = useWindowVirtualizer<HTMLElement>(computed(() => ({
		count: ready.value ? rows.value.length : 0,
		estimateSize: (index: number) => rows.value[index]?.type === 'family' ? 34 : 108,
		getItemKey: (index: number) => rows.value[index]!.key,
		overscan: 3,
		scrollMargin: margin.value,
		rangeExtractor: (range: Parameters<typeof defaultRangeExtractor>[0]) => {
			const indexes = defaultRangeExtractor(range);
			const focused = rows.value.findIndex(row => row.key === focusedKey.value);
			if (focused >= 0 && !indexes.includes(focused)) {
				indexes.push(focused);
			}
			return indexes.sort((left, right) => left - right);
		},
	})));
	const visibleRows = computed(() => {
		const instance = virtualizer.value;
		// Populate measurements even when an embedded preview is outside the window scroll range.
		instance.getTotalSize();
		const items = rows.value.length <= COMPLETE_ROW_LIMIT ? instance.measurementsCache : instance.getVirtualItems();
		// Array.from reads lazy measurement indexes; Array.map skips their unmaterialized slots.
		return Array.from(items, item => ({ ...item, row: rows.value[item.index]!, top: item.start - margin.value }));
	});
	const height = computed(() => virtualizer.value.getTotalSize());

	/** Measure both grid cells together so wrapping channel details retain their natural height. */
	function measureRow(element: Element | ComponentPublicInstance | null): void {
		if (element instanceof HTMLElement) {
			virtualizer.value.measureElement(element);
		}
	}

	/** Keep page-relative offsets current when content above the guide changes size. */
	function measureOffset(): void {
		if (body.value) {
			margin.value = body.value.getBoundingClientRect().top + window.scrollY;
		}
	}

	/** Retain the focused row until focus leaves the timeline. */
	function retainFocus(event: FocusEvent): void {
		const target = event.target as HTMLElement;
		focusedKey.value = target.closest<HTMLElement>('[data-guide-row]')?.dataset.guideRow ?? null;
	}

	/** Release the retained row after focus has settled, including focus moved to a popover. */
	function releaseFocus(): void {
		void nextTick(() => {
			if (!body.value?.contains(document.activeElement)) {
				focusedKey.value = null;
			}
		});
	}

	/** Continue sequential keyboard navigation into a channel whose row is not mounted yet. */
	async function navigateRows(event: KeyboardEvent): Promise<void> {
		if (event.key !== 'Tab' || event.altKey || event.ctrlKey || event.metaKey) {
			return;
		}
		const target = event.target as HTMLElement;
		const row = target.closest<HTMLElement>('[data-index]');
		if (!row) {
			return;
		}
		const selector = 'button:not(:disabled), a[href], input:not(:disabled), [tabindex="0"]';
		const controls = [...row.querySelectorAll<HTMLElement>(selector)];
		if (target !== row && target !== controls[event.shiftKey ? 0 : controls.length - 1]) {
			return;
		}
		const direction = event.shiftKey ? -1 : 1;
		let index = Number(row.dataset.index) + direction;
		while (rows.value[index]?.type === 'family') {
			index += direction;
		}
		if (!rows.value[index]) {
			return;
		}
		event.preventDefault();
		focusedKey.value = rows.value[index]!.key;
		virtualizer.value.scrollToIndex(index, { align: 'auto' });
		await nextTick();
		const next = body.value?.querySelector<HTMLElement>(`[data-index="${index}"]`);
		const candidates = next?.querySelectorAll<HTMLElement>(selector);
		const control = event.shiftKey ? candidates?.[candidates.length - 1] : candidates?.[0];
		(control ?? next)?.focus();
	}

	onMounted(() => {
		measureOffset();
		observer = new ResizeObserver(measureOffset);
		if (body.value?.parentElement) {
			observer.observe(body.value.parentElement);
		}
		window.addEventListener('resize', measureOffset);
	});
	onBeforeUnmount(() => {
		observer?.disconnect();
		window.removeEventListener('resize', measureOffset);
	});
	return { body, visibleRows, height, measureRow, retainFocus, releaseFocus, navigateRows, measureOffset };
}
