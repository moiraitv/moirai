<script setup lang="ts">
import { Plus, Trash2 } from '@lucide/vue';
import type { MidRollPredicate } from '@moirai/shared';
import TwoStepActionButton from '../TwoStepActionButton.vue';

const props = defineProps<{ modelValue: MidRollPredicate; removable?: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [value: MidRollPredicate]; remove: [] }>();
/** Source-content labels expose units without requiring expression variable names. */
const fields = [
	['point', 'Elapsed Content (seconds)'], ['last_mid_filler', 'Since Last Accepted Break (seconds)'],
	['remaining_duration', 'Remaining Content (seconds)'], ['total_duration', 'Total Content (seconds)'],
	['total_progress', 'Content Progress (%)'], ['num', 'Point Number'],
	['total_points', 'Total Points'], ['matched_points', 'Previously Accepted Points'],
] as const;

/** Choose a useful editable rule when changing the condition type. */
function initial(type: MidRollPredicate['type']): MidRollPredicate {
	switch (type) {
		case 'all': case 'any': return { type, children: [initial('number')] };
		case 'always': return { type, negated: false };
		case 'number': return { type, field: 'point', operator: 'gte', value: 600, negated: false };
		case 'every-nth': return { type, interval: 2, remainder: 0, negated: false };
		case 'title': return { type, value: '', negated: false };
	}
}

/** Replace a draft node without mutating its parent. */
function replace(value: MidRollPredicate): void {
	emit('update:modelValue', value);
}

/** Edit leaf properties while retaining its discriminant and unrelated settings. */
function update(value: Record<string, unknown>): void {
	replace({ ...props.modelValue, ...value } as MidRollPredicate);
}

/** Update, append, or remove a group's authored children as one replacement. */
function children(value: MidRollPredicate[]): void {
	if (props.modelValue.type === 'all' || props.modelValue.type === 'any') {
		replace({ ...props.modelValue, children: value });
	}
}

/** Preserve the other siblings when one child changes. */
function child(index: number, value: MidRollPredicate): void {
	if (props.modelValue.type === 'all' || props.modelValue.type === 'any') {
		children(props.modelValue.children.map((entry, position) => position === index ? value : entry));
	}
}

/** Keep groups nonempty when a draft-local removal is confirmed. */
function remove(index: number): void {
	if ((props.modelValue.type === 'all' || props.modelValue.type === 'any') && props.modelValue.children.length > 1) {
		children(props.modelValue.children.filter((_, position) => position !== index));
	}
}

/** Append a condition or nested group using the layer editor's interaction pattern. */
function add(type: 'number' | 'all'): void {
	if (props.modelValue.type === 'all' || props.modelValue.type === 'any') {
		children([...props.modelValue.children, initial(type)]);
	}
}

/** Change numeric fields with a valid unit-specific starting value. */
function field(value: string): void {
	update({ field: value, value: value === 'total_progress' ? 0.5 : value === 'point' ? 600 : 1 });
}

/** Store progress as a fraction while presenting percentages to authors. */
function number(value: number): void {
	if (props.modelValue.type === 'number') {
		update({ value: props.modelValue.field === 'total_progress' ? value / 100 : value });
	}
}
</script>

<template>
	<div class="predicate-node" :class="`predicate-${modelValue.type}`">
		<div class="predicate-node-heading">
			<select aria-label="Predicate type" :value="modelValue.type" @change="replace(initial(($event.target as HTMLSelectElement).value as MidRollPredicate['type']))">
				<option value="all">All conditions</option><option value="any">Any condition</option>
				<option value="always">Always</option><option value="number">Numeric comparison</option>
				<option value="every-nth">Every Nth point</option><option value="title">Chapter title</option>
			</select>
			<label v-if="modelValue.type !== 'all' && modelValue.type !== 'any'" class="predicate-negate">
				<input type="checkbox" :checked="modelValue.negated" @change="update({ negated: ($event.target as HTMLInputElement).checked })" />Exclude
			</label>
			<TwoStepActionButton v-if="removable" class="icon-button danger-icon" label="Remove predicate" confirm-label="Confirm remove predicate" @confirm="emit('remove')"><Trash2 :size="15" /></TwoStepActionButton>
		</div>
		<div v-if="modelValue.type === 'all' || modelValue.type === 'any'" class="predicate-children">
			<MidRollPredicateEditor
				v-for="(entry, index) in modelValue.children" :key="index" :model-value="entry" :removable="modelValue.children.length > 1"
				@update:model-value="child(index, $event)" @remove="remove(index)" />
			<div class="predicate-add-actions">
				<button type="button" class="predicate-add-button" @click="add('number')"><Plus :size="14" />Condition</button>
				<button type="button" class="predicate-add-button" @click="add('all')"><Plus :size="14" />Group</button>
			</div>
		</div>
		<div v-else-if="modelValue.type === 'number'" class="predicate-field-grid">
			<label><span>Content Fact</span><select :value="modelValue.field" @change="field(($event.target as HTMLSelectElement).value)"><option v-for="[key, label] in fields" :key="key" :value="key">{{ label }}</option></select></label>
			<label><span>Comparison</span><select :value="modelValue.operator" @change="update({ operator: ($event.target as HTMLSelectElement).value })">
				<option value="gte">At least</option><option value="gt">More than</option><option value="lte">At most</option><option value="lt">Less than</option><option value="eq">Equals</option><option value="ne">Does not equal</option>
			</select></label>
			<label><span>Value</span><input type="number" min="0" step="any" :max="modelValue.field === 'total_progress' ? 100 : undefined" :value="modelValue.value * (modelValue.field === 'total_progress' ? 100 : 1)" @input="number(Number(($event.target as HTMLInputElement).value))" /></label>
		</div>
		<div v-else-if="modelValue.type === 'every-nth'" class="predicate-field-grid">
			<label><span>Point Interval</span><input type="number" min="1" max="256" :value="modelValue.interval" @input="update({ interval: Number(($event.target as HTMLInputElement).value) })" /></label>
			<label><span>Remainder</span><input type="number" min="0" :max="modelValue.interval - 1" :value="modelValue.remainder" @input="update({ remainder: Number(($event.target as HTMLInputElement).value) })" /></label>
			<small>Point Numbers start at one. An interval of two with remainder zero matches points 2, 4, 6, and so on.</small>
		</div>
		<label v-else-if="modelValue.type === 'title'" class="predicate-field"><span>Exact Chapter Title</span><input :value="modelValue.value" maxlength="512" @input="update({ value: ($event.target as HTMLInputElement).value })" /><small>Timed points have an empty title. Matching preserves capitalization.</small></label>
	</div>
</template>
