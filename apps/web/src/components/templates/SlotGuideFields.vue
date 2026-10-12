<script setup lang="ts">
import { GUIDE_ARTWORK_CONTENT_TYPES, GUIDE_ARTWORK_MAX_BYTES, GUIDE_ARTWORK_MAX_DIMENSION, MAX_XMLTV_DESCRIPTION_LENGTH, type ScheduleSlot } from '@moirai/shared';
import { ref } from 'vue';
import TwoStepActionButton from '../TwoStepActionButton.vue';

defineProps<{ programName: string; artworkUrl?: string | undefined; disabled?: boolean }>();
const imageError = ref('');
const artworkInput = ref<HTMLInputElement>();

const slot = defineModel<ScheduleSlot>({ required: true });
const emit = defineEmits<{ change: []; artwork: [file: File | null] }>();

/** Enable a custom listing with scheduled boundaries, or restore individual listings. */
function changeMode(event: Event): void {
	slot.value.guide = (event.target as HTMLSelectElement).value === 'block'
		? { mode: 'block', title: '', description: '', boundary: 'scheduled' }
		: { mode: 'items' };
	emit('change');
}

/** Validate the local file before retaining it as an unsaved artwork selection. */
function chooseArtwork(event: Event): void {
	const input = event.target as HTMLInputElement;
	const file = input.files?.[0];
	input.value = '';
	if (!file) {
		return;
	}

	imageError.value = '';
	if (!GUIDE_ARTWORK_CONTENT_TYPES.some(type => type === file.type) || file.size > GUIDE_ARTWORK_MAX_BYTES) {
		imageError.value = `Choose PNG, JPEG, or WebP artwork up to ${GUIDE_ARTWORK_MAX_BYTES / 1024 / 1024} MiB.`;
		return;
	}
	emit('artwork', file);
	emit('change');
}

/** Remove only the draft reference, leaving the persisted image intact until Save. */
function removeArtwork(): void {
	imageError.value = '';
	emit('artwork', null);
	emit('change');
}
</script>

<template>
	<fieldset class="slot-guide-fields" :disabled="disabled">
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
		<div v-if="slot.guide?.mode === 'block'" class="slot-guide-artwork">
			<strong>Guide artwork (optional)</strong>
			<img v-if="artworkUrl" :src="artworkUrl" alt="Guide artwork preview" />
			<input ref="artworkInput" class="visually-hidden" type="file" tabindex="-1" :accept="GUIDE_ARTWORK_CONTENT_TYPES.join(',')" aria-label="Guide artwork" @change="chooseArtwork" />
			<button class="button secondary" type="button" :disabled="disabled" @click="artworkInput?.click()">
				{{ artworkUrl ? 'Replace image' : 'Choose image' }}
			</button>
			<TwoStepActionButton v-if="artworkUrl" class="button secondary" confirm-text="Remove" label="Remove artwork" confirm-label="Confirm remove artwork" :disabled="disabled" @confirm="removeArtwork">Remove</TwoStepActionButton>
			<p class="field-hint">PNG, JPEG, or WebP, up to {{ GUIDE_ARTWORK_MAX_BYTES / 1024 / 1024 }} MiB and {{ GUIDE_ARTWORK_MAX_DIMENSION }} pixels per dimension. Applied when you save the template.</p>
			<p v-if="imageError" role="alert" class="error">{{ imageError }}</p>
		</div>
		<p class="field-hint">Changes the Guide page and XMLTV listings only. Playback is unchanged.</p>
		<p v-if="slot.guide?.mode === 'block'" class="field-hint">
			Leave the guide title empty to use the program name.
			Scheduled boundaries keep the slot’s clock times, even if different content airs.
			Include drift follows the slot’s actual start and finish.
		</p>
	</fieldset>
</template>
