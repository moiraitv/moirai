<script setup lang="ts">
import { MAX_XMLTV_DESCRIPTION_LENGTH, type ScheduleSlot } from '@moirai/shared';

defineProps<{ programName: string }>();

const slot = defineModel<ScheduleSlot>({ required: true });
const emit = defineEmits<{ change: [] }>();

/** Enable a custom listing with scheduled boundaries, or restore individual listings. */
function changeMode(event: Event): void {
	slot.value.guide = (event.target as HTMLSelectElement).value === 'block'
		? { mode: 'block', title: '', description: '', boundary: 'scheduled' }
		: { mode: 'items' };
	emit('change');
}
</script>

<template>
	<fieldset class="slot-guide-fields">
		<legend>Guide output</legend>
		<div class="form-grid">
			<label><span>Show in guide</span>
				<select :value="slot.guide?.mode ?? 'items'" @change="changeMode">
					<option value="items">Individual items</option>
					<option value="block">Single block</option>
				</select>
			</label>
			<template v-if="slot.guide?.mode === 'block'">
				<label><span>Guide title</span>
					<input v-model="slot.guide.title" maxlength="120" :placeholder="programName" @input="emit('change')" />
				</label>
				<label><span>Guide timing</span>
					<select v-model="slot.guide.boundary" @change="emit('change')">
						<option value="scheduled">Scheduled boundaries</option>
						<option value="drift">Include drift</option>
					</select>
				</label>
				<label><span>Guide description (optional)</span>
					<input v-model="slot.guide.description" type="text" :maxlength="MAX_XMLTV_DESCRIPTION_LENGTH" @input="emit('change')" />
				</label>
			</template>
		</div>
		<p class="field-hint">Changes the Guide page and XMLTV listings only. Playback is unchanged.</p>
		<p v-if="slot.guide?.mode === 'block'" class="field-hint">
			Leave the guide title empty to use the program name.
			Scheduled boundaries keep the slot’s clock times, even if different content airs.
			Include drift follows the slot’s actual start and finish.
		</p>
	</fieldset>
</template>
