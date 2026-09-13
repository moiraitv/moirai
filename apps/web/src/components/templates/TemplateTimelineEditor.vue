<script setup lang="ts">
import { ref } from 'vue';
import { List, Plus, Timeline, X } from '@lucide/vue';
import { SECONDS_PER_SCHEDULING_DAY, type ScheduleSlot, type ScheduleTemplateCreate } from '@moirai/shared';
import { programColorStyle } from '../../program-colors';
import type { SlotPlacement } from '../../schedule-geometry';

defineProps<{
	draft: ScheduleTemplateCreate & { id: string };
	sortedSlots: ScheduleSlot[];
	selectedSlotId: string;
	editorView: 'timeline' | 'list';
	addingSlot: boolean;
	slotPlacement: SlotPlacement | null;
	placementStyle: Record<string, string>;
	usedPrograms: Array<{ id: string; name: string }>;
	canAddSlot: boolean;
	placementAnnouncement: string;
	programName: (id: string | null) => string;
	timeLabel: (seconds: number) => string;
	slotEnd: (slot: ScheduleSlot) => number;
	slotDurationLabel: (slot: ScheduleSlot) => string;
}>();
const emit = defineEmits<{
	'update:selectedSlotId': [id: string];
	beginSlotPlacement: [];
	setEditorView: [view: 'timeline' | 'list'];
	pointerMove: [event: PointerEvent];
	pointerUp: [];
	placementKeydown: [event: KeyboardEvent];
	slotClick: [event: MouseEvent, slot: ScheduleSlot];
	boundaryPointerDown: [event: PointerEvent, slotId: string];
}>();
const timelineBar = ref<HTMLElement>();
defineExpose({ timelineBar });

/** Route pointer movement to placement or boundary dragging based on the active mode. */
function handlePointerMove(event: PointerEvent): void {
	emit('pointerMove', event);
}
</script>

<template>
	<section
		class="template-schedule-card editor-surface"
		aria-label="Nominal template day"
	>
		<div class="template-schedule-main">
			<div class="template-day-summary">
				<strong>{{ draft.name || 'Untitled template' }}</strong>
				<span>{{ timeLabel(0) }} – {{ timeLabel(SECONDS_PER_SCHEDULING_DAY) }}</span>
				<small
				>{{ sortedSlots.length }} slot{{ sortedSlots.length === 1 ? '' : 's' }}</small
				>
			</div>
			<div class="template-timeline-column">
				<div v-if="editorView === 'timeline'" class="template-hours">
					<span v-for="hour in [0, 3, 6, 9, 12, 15, 18, 21, 24]" :key="hour"
					>{{ timeLabel(hour * 3_600) }}</span
					>
				</div>
				<div
					v-if="editorView === 'timeline'"
					ref="timelineBar"
					class="template-timeline"
					:class="{ 'adding-slot': addingSlot }"
					:tabindex="addingSlot ? 0 : -1"
					:aria-describedby="addingSlot ? 'slot-placement-instructions' : undefined"
					@pointermove="handlePointerMove"
					@pointerup="emit('pointerUp')"
					@pointercancel="emit('pointerUp')"
					@keydown="emit('placementKeydown', $event)"
				>
					<button
						v-for="slot in sortedSlots"
						:key="slot.id"
						class="template-slot"
						:data-program-id="slot.programId"
						:class="{
							selected: slot.id === selectedSlotId,
							'fall-through-slot': slot.programId === null,
						}"
						:style="{
							...programColorStyle(slot.programId),
							left: `${(slot.startSeconds / SECONDS_PER_SCHEDULING_DAY) * 100}%`,
							width: `${((slotEnd(slot) - slot.startSeconds) / SECONDS_PER_SCHEDULING_DAY) * 100}%`,
						}"
						:title="`${programName(slot.programId)} · ${timeLabel(slot.startSeconds)}–${timeLabel(slotEnd(slot))}`"
						:tabindex="addingSlot ? -1 : 0"
						@click="emit('slotClick', $event, slot)"
					>
						<strong>{{ programName(slot.programId) }}</strong>
						<small
						>{{ timeLabel(slot.startSeconds) }}–{{ timeLabel(slotEnd(slot)) }}</small
						>
						<span
							v-if="slot.startSeconds > 0 && !addingSlot"
							class="boundary-handle"
							@pointerdown.stop="emit('boundaryPointerDown', $event, slot.id)"
						></span>
					</button>
					<span
						v-if="addingSlot && slotPlacement"
						class="slot-placement-marker"
						:style="placementStyle"
						aria-hidden="true"
					>
						<i><Plus :size="15" /></i>
						<small>{{ timeLabel(slotPlacement.splitSeconds) }}</small>
					</span>
				</div>
				<p
					v-if="addingSlot"
					id="slot-placement-instructions"
					class="slot-placement-instructions"
				>
					Choose where to divide the timeline. Adding a slot keeps the full day allocated.
					<span>Click or press Enter to add · Arrow keys adjust · Esc cancels</span>
				</p>
				<div v-else-if="editorView === 'list'" class="template-slot-list" aria-label="Template slots">
					<button
						v-for="slot in sortedSlots"
						:key="slot.id"
						:class="{
							selected: slot.id === selectedSlotId,
							'fall-through-slot': slot.programId === null,
						}"
						:style="programColorStyle(slot.programId)"
						:data-program-id="slot.programId"
						@click="emit('update:selectedSlotId', slot.id)"
					>
						<span class="program-color-dot"></span>
						<strong>{{ programName(slot.programId) }}</strong>
						<span>{{ timeLabel(slot.startSeconds) }}–{{ timeLabel(slotEnd(slot)) }}</span>
						<small>{{ slotDurationLabel(slot) }}</small>
					</button>
				</div>
			</div>
		</div>
		<footer class="template-schedule-footer">
			<div class="template-program-legend" aria-label="Programs used by this template">
				<span
					v-for="program in usedPrograms"
					:key="program.id"
					:style="programColorStyle(program.id)"
					:data-program-id="program.id"
				>
					<i></i>{{ program.name }}
				</span>
			</div>
			<div class="template-schedule-actions">
				<button
					type="button"
					class="toolbar-button add-slot-button"
					:class="{ active: addingSlot }"
					:disabled="!canAddSlot"
					:aria-pressed="addingSlot"
					:title="
						canAddSlot
							? 'Add by dividing an existing slot'
							: 'No slot is long enough to divide'
					"
					@click="emit('beginSlotPlacement')"
				>
					<X v-if="addingSlot" :size="16" />
					<Plus v-else :size="16" />
					{{ addingSlot ? 'Cancel Adding' : 'Add Slot' }}
				</button>
				<span class="template-control-divider" aria-hidden="true"></span>
				<div
					class="template-view-controls"
					role="group"
					aria-label="Template editor view"
				>
					<button
						type="button"
						:class="{ active: editorView === 'timeline' }"
						:aria-pressed="editorView === 'timeline'"
						@click="emit('setEditorView', 'timeline')"
					>
						<Timeline :size="16" />Timeline
					</button>
					<button
						type="button"
						:class="{ active: editorView === 'list' }"
						:aria-pressed="editorView === 'list'"
						@click="emit('setEditorView', 'list')"
					>
						<List :size="16" />List
					</button>
				</div>
			</div>
		</footer>
		<p class="visually-hidden" aria-live="polite">{{ placementAnnouncement }}</p>
	</section>
</template>
