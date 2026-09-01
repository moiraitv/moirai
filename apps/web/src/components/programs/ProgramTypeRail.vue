<script setup lang="ts">
/** Program configuration modes supported by the editor. */
type ProgramType = 'content' | 'sequence';

const props = withDefaults(defineProps<{ modelValue: ProgramType; disabled?: boolean }>(), {
	disabled: false,
});
const emit = defineEmits<{ 'update:modelValue': [value: ProgramType] }>();

/** Select the editor mode represented by the clicked radio option. */
function select(value: ProgramType): void {
	if (props.disabled) {
		return;
	}

	emit('update:modelValue', value);
}
</script>

<template>
	<aside class="program-editor-rail">
		<h3 id="program-type-heading">Program type</h3>
		<p v-if="!disabled" id="program-type-description">Choose the kind of reusable rule you want to create.</p>
		<div v-if="disabled" class="program-type-fixed">
			<span class="program-type-radio" aria-hidden="true"></span>
			<span class="program-type-copy">
				<strong>{{ modelValue === 'content' ? 'Content' : 'Sequence' }}</strong>
				<small>{{ modelValue === 'content' ? 'Choose what can play' : 'Arrange programs in a custom order' }}</small>
			</span>
		</div>
		<div v-else class="program-type-options" role="radiogroup" aria-labelledby="program-type-heading" aria-describedby="program-type-description">
			<label v-for="option in [{ value: 'content', title: 'Content', detail: 'Choose what can play' }, { value: 'sequence', title: 'Sequence', detail: 'Arrange programs in a custom order' }] as const" :key="option.value" :class="{ active: modelValue === option.value }">
				<input :checked="modelValue === option.value" type="radio" :value="option.value" @change="select(option.value)" />
				<span class="program-type-radio" aria-hidden="true"></span>
				<span class="program-type-copy"><strong>{{ option.title }}</strong><small>{{ option.detail }}</small></span>
			</label>
		</div>
	</aside>
</template>
