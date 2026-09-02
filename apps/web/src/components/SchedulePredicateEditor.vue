<script setup lang="ts">
import { Plus, Trash2 } from '@lucide/vue';
import type { SchedulePredicate } from '@moirai/shared';
import { dateKey } from '../date-key';
import TwoStepDeleteButton from './TwoStepDeleteButton.vue';

const props = defineProps<{
	modelValue: SchedulePredicate;
	removable?: boolean;
	timeZone?: string | undefined;
}>();
const emit = defineEmits<{
	'update:modelValue': [value: SchedulePredicate];
	remove: [];
}>();

const weekdays = [
	[1, 'Mon'],
	[2, 'Tue'],
	[3, 'Wed'],
	[4, 'Thu'],
	[5, 'Fri'],
	[6, 'Sat'],
	[7, 'Sun'],
] as const;
const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Format predicate seconds as an HTML time-field value. */
function timeValue(seconds: number): string {
	return `${String(Math.floor(seconds / 3_600)).padStart(2, '0')}:${String(
		Math.floor((seconds % 3_600) / 60),
	).padStart(2, '0')}`;
}

/** Parse an HTML time-field value into nominal seconds. */
function timeSeconds(value: string): number {
	const [hours, minutes] = value.split(':').map(Number);
	return (hours ?? 0) * 3_600 + (minutes ?? 0) * 60;
}

/** Create the initial predicate leaf for the selected condition type. */
function defaultLeaf(type: Exclude<SchedulePredicate['type'], 'all' | 'any'>): SchedulePredicate {
	const today = dateKey(new Date(), props.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
	switch (type) {
		case 'months':
			return { type, values: [1], negated: false };
		case 'weekdays':
			return { type, values: [1, 2, 3, 4, 5], negated: false };
		case 'dates':
			return { type, values: [today], negated: false };
		case 'date-range': {
			return { type, startDate: today, endDate: today, negated: false };
		}
		case 'annual-range':
			return {
				type,
				start: { month: 1, day: 1 },
				end: { month: 1, day: 1 },
				negated: false,
			};
		case 'time-range':
			return { type, startSeconds: 12 * 3_600, endSeconds: 17 * 3_600, negated: false };
	}
}

/** Emit a cloned predicate replacement without mutating the input prop. */
function replace(value: SchedulePredicate): void {
	emit('update:modelValue', value);
}

/** Read whether the current predicate leaf is negated. */
function leafNegated(predicate: SchedulePredicate): boolean {
	return 'negated' in predicate && predicate.negated;
}

/** Toggle exclusion on a leaf predicate without changing grouped predicates. */
function setNegated(value: boolean): void {
	const predicate = props.modelValue;
	if (predicate.type === 'all' || predicate.type === 'any') {
		return;
	}

	replace({ ...predicate, negated: value } as SchedulePredicate);
}

/** Replace the predicate with a valid default of the selected condition type. */
function changeType(type: SchedulePredicate['type']): void {
	replace(
		type === 'all' || type === 'any'
			? { type, children: [defaultLeaf('weekdays')] }
			: defaultLeaf(type),
	);
}

/** Replace one grouped condition without mutating the input predicate. */
function updateChild(index: number, value: SchedulePredicate): void {
	if (props.modelValue.type !== 'all' && props.modelValue.type !== 'any') {
		return;
	}

	const children = [...props.modelValue.children];
	children[index] = value;
	replace({ ...props.modelValue, children });
}

/** Remove one grouped condition while preserving at least one child. */
function removeChild(index: number): void {
	if (
		(props.modelValue.type !== 'all' && props.modelValue.type !== 'any')
		|| props.modelValue.children.length <= 1
	) {
		return;
	}

	replace({
		...props.modelValue,
		children: props.modelValue.children.filter((_, i) => i !== index),
	});
}

/** Append either a condition leaf or a nested all-conditions group. */
function addChild(group: boolean): void {
	if (props.modelValue.type !== 'all' && props.modelValue.type !== 'any') {
		return;
	}

	replace({
		...props.modelValue,
		children: [
			...props.modelValue.children,
			group ? { type: 'all', children: [defaultLeaf('weekdays')] } : defaultLeaf('weekdays'),
		],
	});
}

/** Toggle a month or weekday while preventing an empty selection. */
function toggleNumber(value: number): void {
	const predicate = props.modelValue;
	if (predicate.type !== 'months' && predicate.type !== 'weekdays') {
		return;
	}

	const values = predicate.values.includes(value)
		? predicate.values.filter((entry) => entry !== value)
		: [...predicate.values, value].sort((left, right) => left - right);
	if (values.length > 0) {
		replace({ ...predicate, values });
	}
}
</script>

<template>
	<div class="predicate-node" :class="`predicate-${modelValue.type}`">
		<div class="predicate-node-heading">
			<select
				aria-label="Predicate type"
				:value="modelValue.type"
				@change="
					changeType(($event.target as HTMLSelectElement).value as SchedulePredicate['type'])
				"
			>
				<option value="all">All conditions</option>
				<option value="any">Any condition</option>
				<option value="months">Months</option>
				<option value="weekdays">Weekdays</option>
				<option value="dates">Exact dates</option>
				<option value="date-range">Date range</option>
				<option value="annual-range">Recurring annual range</option>
				<option value="time-range">Time range</option>
			</select>
			<label v-if="modelValue.type !== 'all' && modelValue.type !== 'any'" class="predicate-negate">
				<input
					type="checkbox"
					:checked="leafNegated(modelValue)"
					@change="setNegated(($event.target as HTMLInputElement).checked)"
				/>
				Exclude
			</label>
			<TwoStepDeleteButton
				v-if="removable"
				class="icon-button danger-icon"
				label="Remove predicate"
				confirm-label="Confirm remove predicate"
				@confirm="emit('remove')"
			>
				<Trash2 :size="15" />
			</TwoStepDeleteButton>
		</div>

		<div v-if="modelValue.type === 'all' || modelValue.type === 'any'" class="predicate-children">
			<SchedulePredicateEditor
				v-for="(child, index) in modelValue.children"
				:key="index"
				:model-value="child"
				:time-zone="timeZone"
				removable
				@update:model-value="updateChild(index, $event)"
				@remove="removeChild(index)"
			/>
			<div class="predicate-add-actions">
				<button type="button" class="predicate-add-button" @click="addChild(false)">
					<Plus :size="14" />Condition
				</button>
				<button type="button" class="predicate-add-button" @click="addChild(true)">
					<Plus :size="14" />Group
				</button>
			</div>
		</div>

		<div v-else-if="modelValue.type === 'months'" class="predicate-choice-grid months">
			<label v-for="(month, index) in months" :key="month">
				<input
					type="checkbox"
					:checked="modelValue.values.includes(index + 1)"
					@change="toggleNumber(index + 1)"
				/>{{ month }}
			</label>
		</div>
		<div v-else-if="modelValue.type === 'weekdays'" class="predicate-choice-grid">
			<label v-for="weekday in weekdays" :key="weekday[0]">
				<input
					type="checkbox"
					:checked="modelValue.values.includes(weekday[0])"
					@change="toggleNumber(weekday[0])"
				/>{{ weekday[1] }}
			</label>
		</div>
		<label v-else-if="modelValue.type === 'dates'" class="predicate-field">
			<span>Dates, comma separated</span>
			<input
				:value="modelValue.values.join(', ')"
				@change="
					replace({
						...modelValue,
						values: ($event.target as HTMLInputElement).value
							.split(',')
							.map((value) => value.trim())
							.filter(Boolean),
					})
				"
			/>
		</label>
		<div v-else-if="modelValue.type === 'date-range'" class="predicate-field-grid">
			<label
			><span>Starts</span
			><input
				:value="modelValue.startDate"
				type="date"
				@input="replace({ ...modelValue, startDate: ($event.target as HTMLInputElement).value })"
			/></label>
			<label
			><span>Ends</span
			><input
				:value="modelValue.endDate"
				type="date"
				@input="replace({ ...modelValue, endDate: ($event.target as HTMLInputElement).value })"
			/></label>
		</div>
		<div v-else-if="modelValue.type === 'annual-range'" class="predicate-field-grid">
			<label
			><span>Start month/day</span
			><input
				:value="`${String(modelValue.start.month).padStart(2, '0')}-${String(modelValue.start.day).padStart(2, '0')}`"
				pattern="\d{2}-\d{2}"
				@change="
					replace({
						...modelValue,
						start: {
							month: Number(($event.target as HTMLInputElement).value.split('-')[0]),
							day: Number(($event.target as HTMLInputElement).value.split('-')[1]),
						},
					})
				"
			/></label>
			<label
			><span>End month/day</span
			><input
				:value="`${String(modelValue.end.month).padStart(2, '0')}-${String(modelValue.end.day).padStart(2, '0')}`"
				pattern="\d{2}-\d{2}"
				@change="
					replace({
						...modelValue,
						end: {
							month: Number(($event.target as HTMLInputElement).value.split('-')[0]),
							day: Number(($event.target as HTMLInputElement).value.split('-')[1]),
						},
					})
				"
			/></label>
		</div>
		<div v-else-if="modelValue.type === 'time-range'" class="predicate-field-grid">
			<label
			><span>Starts</span
			><input
				type="time"
				:value="timeValue(modelValue.startSeconds)"
				@change="
					replace({
						...modelValue,
						startSeconds: timeSeconds(($event.target as HTMLInputElement).value),
					})
				"
			/></label>
			<label
			><span>Ends</span
			><input
				type="time"
				:value="timeValue(modelValue.endSeconds)"
				@change="
					replace({
						...modelValue,
						endSeconds: timeSeconds(($event.target as HTMLInputElement).value),
					})
				"
			/></label>
		</div>
	</div>
</template>
