<script setup lang="ts">
/** Program configuration modes supported by the editor. */
type ProgramType = 'content' | 'sequence';

defineProps<{ modelValue: ProgramType }>();
const emit = defineEmits<{ 'update:modelValue': [value: ProgramType] }>();

/** Select the editor mode represented by the clicked radio option. */
function select(value: ProgramType): void {
	emit('update:modelValue', value);
}
</script>

<template>
	<aside class="program-editor-rail">
		<h3 id="program-type-heading">Program type</h3>
		<p id="program-type-description">Choose the kind of reusable rule you want to create.</p>
		<div class="program-type-options" role="radiogroup" aria-labelledby="program-type-heading" aria-describedby="program-type-description">
			<label v-for="option in [{ value: 'content', title: 'Content', detail: 'Choose what can play' }, { value: 'sequence', title: 'Sequence', detail: 'Arrange programs in a custom order' }] as const" :key="option.value" :class="{ active: modelValue === option.value }">
				<input :checked="modelValue === option.value" type="radio" :value="option.value" @change="select(option.value)" />
				<span class="program-type-radio" aria-hidden="true"></span>
				<span class="program-type-copy"><strong>{{ option.title }}</strong><small>{{ option.detail }}</small></span>
			</label>
		</div>
	</aside>
</template>
