<script setup lang="ts" generic="Option extends { id: string; name: string }">
import { ChevronDown } from '@lucide/vue';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId } from 'vue';

const props = defineProps<{ label: string; options: Option[]; disabled?: boolean }>();
const model = defineModel<string>({ required: true });
const id = useId();
const open = ref(false);
const active = ref(-1);
const trigger = ref<HTMLButtonElement>();
const list = ref<HTMLElement>();
const selected = computed(() => props.options.find(option => option.id === model.value));
let anchorBounds: DOMRect | undefined;

/** Keep the highlighted choice inside the visible part of the scrollable popup. */
async function highlight(index: number): Promise<void> {
	active.value = index;
	await nextTick();
	list.value?.children[index]?.scrollIntoView({ block: 'nearest' });
}

/** Open above the editor chrome and use the available viewport space on either side. */
function show(): void {
	const popup = list.value;
	const bounds = trigger.value?.getBoundingClientRect();
	if (!popup || !bounds) {
		return;
	}

	const gap = 4;
	const edge = 8;
	const viewportHeight = document.documentElement.clientHeight;
	const above = bounds.top - gap - edge;
	const below = viewportHeight - bounds.bottom - gap - edge;
	const openAbove = below < Math.min(2, props.options.length) * bounds.height && above > below;
	anchorBounds = bounds;
	Object.assign(popup.style, {
		left: `${bounds.left}px`,
		width: `${bounds.width}px`,
		top: openAbove ? 'auto' : `${bounds.bottom + gap}px`,
		bottom: openAbove ? `${viewportHeight - bounds.top + gap}px` : 'auto',
		maxHeight: `min(15rem, ${Math.max(0, openAbove ? above : below)}px)`,
	});
	popup.showPopover();
	open.value = true;
	void highlight(Math.max(0, props.options.findIndex(option => option.id === model.value)));
}

/** Close the popup immediately so a second Escape can dismiss the editor. */
function close(): void {
	list.value?.hidePopover();
	open.value = false;
}

/** Reflect native light dismissal in the combobox state. */
function syncExpanded(): void {
	open.value = Boolean(list.value?.matches(':popover-open'));
}

/** Dismiss when focus leaves the picker while allowing the popup itself to take focus. */
function dismissOnBlur(event: FocusEvent): void {
	const picker = event.currentTarget as HTMLElement;
	if (!picker.contains(event.relatedTarget as Node | null)) {
		close();
	}
}

/** Close when the anchor moves, keeping the popup scrollable on its own. */
function dismissOnViewportChange(event: Event): void {
	if (!open.value) {
		return;
	}
	const bounds = trigger.value?.getBoundingClientRect();
	if (event.type === 'resize' || bounds?.top !== anchorBounds?.top || bounds?.left !== anchorBounds?.left) {
		close();
	}
}

/** Commit the chosen value and return to the closed picker. */
function choose(option: Option): void {
	model.value = option.id;
	close();
}

/** Keep keyboard navigation inside the list without submitting or dismissing the editor. */
function keydown(event: KeyboardEvent): void {
	const { key } = event;
	if (key === 'ArrowDown' || key === 'ArrowUp' || key === 'Home' || key === 'End') {
		event.preventDefault();
		if (!open.value) {
			show();
		}
		else {
			const last = props.options.length - 1;
			const index = key === 'Home' ? 0 : key === 'End' ? last
				: Math.max(0, Math.min(last, active.value + (key === 'ArrowDown' ? 1 : -1)));
			void highlight(index);
		}
	}
	else if (open.value && (key === 'Enter' || key === ' ')) {
		event.preventDefault();
		const option = props.options[active.value];
		if (option) {
			choose(option);
		}
	}
	else if (open.value && key === 'Escape') {
		event.preventDefault();
		event.stopPropagation();
		close();
	}
	else if (key.length === 1 && key.trim() && !event.ctrlKey && !event.metaKey && !event.altKey) {
		const index = props.options.findIndex(option => option.name.toLowerCase().startsWith(key.toLowerCase()));
		if (index >= 0) {
			event.preventDefault();
			if (!open.value) {
				show();
			}
			void highlight(index);
		}
	}
}

onMounted(() => {
	window.addEventListener('resize', dismissOnViewportChange);
	window.addEventListener('scroll', dismissOnViewportChange, true);
});
onBeforeUnmount(() => {
	window.removeEventListener('resize', dismissOnViewportChange);
	window.removeEventListener('scroll', dismissOnViewportChange, true);
});
</script>

<template>
	<div class="graphics-picker" @focusout="dismissOnBlur" @keydown="keydown">
		<label :id="`${id}-label`" :for="id">{{ label }}</label>
		<div class="graphics-picker-control">
			<button
				:id="id" ref="trigger" type="button" role="combobox" class="graphics-picker-trigger" :aria-labelledby="`${id}-label`"
				:aria-expanded="open" :aria-controls="`${id}-options`"
				:aria-activedescendant="open && active >= 0 ? `${id}-option-${active}` : undefined"
				:disabled="disabled" @click="open ? close() : show()">
				<slot v-if="selected" :option="selected" :animated="!open" />
				<span v-else>Unavailable</span>
				<ChevronDown class="graphics-picker-chevron" :size="16" aria-hidden="true" />
			</button>
			<div :id="`${id}-options`" ref="list" popover="auto" class="graphics-picker-options" role="listbox" :aria-labelledby="`${id}-label`" @toggle="syncExpanded">
				<div
					v-for="(option, index) in open ? options : []" :id="`${id}-option-${index}`" :key="option.id" role="option"
					:aria-selected="option.id === model" :class="{ active: active === index }"
					@pointerdown.prevent @pointerenter="active = index" @click="choose(option)">
					<slot :option="option" :animated="active === index" />
				</div>
			</div>
		</div>
	</div>
</template>
