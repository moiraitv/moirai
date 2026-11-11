<script setup lang="ts">
import { ChevronDown, Plus, Trash2 } from '@lucide/vue';
import { MAX_PROGRAM_METADATA_FIELDS, MAX_PROGRAM_METADATA_KEY_LENGTH, MAX_PROGRAM_METADATA_VALUE_LENGTH, programMetadataKeySchema } from '@moirai/shared';
import { computed } from 'vue';
import FormDisclosure from '../FormDisclosure.vue';
import TwoStepActionButton from '../TwoStepActionButton.vue';
import { randomUuid } from '../../random-uuid';

defineProps<{ disabled: boolean; step: number }>();
const rows = defineModel<Array<{ id: string; key: string; value: string }>>({ required: true });
const duplicateKeys = computed(() => {
	const seen = new Set<string>();
	return new Set(rows.value.flatMap(({ key }) => {
		if (seen.has(key)) {
			return [key];
		}
		seen.add(key);
		return [];
	}));
});
</script>

<template>
	<FormDisclosure class="program-metadata-disclosure">
		<template #summary>
			<div class="program-section-heading">
				<span>{{ step }}</span>
				<div class="program-section-heading-copy">
					<strong>Guide and graphics metadata</strong>
					<p class="program-section-description">Add custom text fields for your guide templates and graphics.</p>
				</div>
			</div>
			<ChevronDown class="form-disclosure-chevron" :size="22" aria-hidden="true" />
		</template>
		<div class="program-metadata-fields">
			<p>Use <code v-pre>{{ program.metadata.showcase_actor }}</code> to display a field named <code>showcase_actor</code>. A blank value clears any inherited value for that key.</p>
			<div v-for="(row, index) in rows" :key="row.id" class="program-metadata-row">
				<label>
					<span>Key</span>
					<input
						v-model="row.key" :disabled="disabled" :maxlength="MAX_PROGRAM_METADATA_KEY_LENGTH" spellcheck="false" placeholder="showcase_actor"
						:aria-invalid="!programMetadataKeySchema.safeParse(row.key).success || duplicateKeys.has(row.key)" :aria-describedby="`${row.id}-metadata-error`" />
					<small :id="`${row.id}-metadata-error`">
						{{ duplicateKeys.has(row.key) ? 'Each key must be unique.' : !programMetadataKeySchema.safeParse(row.key).success ? 'Use a valid name with letters, digits, or underscores. Start with a letter or underscore.' : '' }}
					</small>
				</label>
				<label><span>Value</span><input v-model="row.value" :disabled="disabled" :maxlength="MAX_PROGRAM_METADATA_VALUE_LENGTH" placeholder="Sigourney Weaver" /></label>
				<TwoStepActionButton
					class="icon-button danger-icon" :disabled="disabled" :label="`Remove metadata field ${row.key || index + 1}`"
					:confirm-label="`Confirm remove metadata field ${row.key || index + 1}`" @confirm="rows.splice(index, 1)">
					<Trash2 :size="16" aria-hidden="true" />
				</TwoStepActionButton>
			</div>
			<button
				type="button" class="button secondary" :disabled="disabled || rows.length >= MAX_PROGRAM_METADATA_FIELDS"
				@click="rows.push({ id: randomUuid(), key: '', value: '' })"><Plus :size="16" aria-hidden="true" />Add field</button>
		</div>
	</FormDisclosure>
</template>
