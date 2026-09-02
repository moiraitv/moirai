<script setup lang="ts">
import { useId } from 'vue';

defineOptions({ inheritAttrs: false });

const props = defineProps<{
	modelValue: boolean;
	contentId?: string;
}>();
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>();
const generatedId = useId();
const resolvedContentId = props.contentId ?? `disclosure-${generatedId}`;

/** Toggle the controlled disclosure while retaining its content for a smooth height transition. */
function toggle(): void {
	emit('update:modelValue', !props.modelValue);
}

/** Prepare disclosure content to expand from zero to its measured natural height. */
function beginExpand(element: Element): void {
	const content = element as HTMLElement;
	content.style.height = '0';
	requestAnimationFrame(() => {
		content.style.height = `${content.scrollHeight}px`;
	});
}

/** Release the measured height after expansion so later content changes remain unconstrained. */
function finishExpand(element: Element): void {
	(element as HTMLElement).style.height = 'auto';
}

/** Capture the current natural height before collapsing the disclosure to zero. */
function beginCollapse(element: Element): void {
	const content = element as HTMLElement;
	content.style.height = `${content.scrollHeight}px`;
	void content.offsetHeight;
	requestAnimationFrame(() => {
		content.style.height = '0';
	});
}
</script>

<template>
	<div v-bind="$attrs" class="animated-disclosure" :class="{ 'is-open': modelValue }">
		<button
			type="button"
			class="animated-disclosure-trigger"
			:aria-expanded="modelValue"
			:aria-controls="resolvedContentId"
			@click="toggle"
		>
			<slot name="summary"></slot>
		</button>
		<Transition
			name="animated-disclosure"
			@enter="beginExpand"
			@after-enter="finishExpand"
			@before-leave="beginCollapse"
		>
			<div
				v-show="modelValue"
				:id="resolvedContentId"
				class="animated-disclosure-content"
				:aria-hidden="!modelValue"
				:inert="!modelValue"
			>
				<slot></slot>
			</div>
		</Transition>
	</div>
</template>
