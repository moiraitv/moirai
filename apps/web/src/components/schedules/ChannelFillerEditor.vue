<script setup lang="ts">
import { computed } from 'vue';
import { isFillerProgram, canonicalFillerPolicy } from '@moirai/shared';
import { Pencil } from '@lucide/vue';
import type { FillerConfig, SchedulingProgram } from '@moirai/shared';

const props = defineProps<{
	modelValue: FillerConfig | null;
	programs: SchedulingProgram[];
}>();
const emit = defineEmits<{
	'update:modelValue': [value: FillerConfig | null];
	'edit-program': [programId: string];
}>();
const fillerPrograms = computed(() => props.programs.filter(isFillerProgram));

/** Enable channel fallback filler with the first program, or remove its configuration. */
function toggleFiller(enabled: boolean): void {
	const programId = fillerPrograms.value[0]?.id;
	emit(
		'update:modelValue',
		enabled && programId ? { programId, policy: 'best-fit-or-truncate' } : null,
	);
}

/** Replace the selected filler program while retaining its fit policy. */
function updateProgram(programId: string): void {
	if (props.modelValue) {
		emit('update:modelValue', { ...props.modelValue, programId });
	}
}

/** Replace the filler selection policy while retaining its program. */
function updatePolicy(policy: FillerConfig['policy']): void {
	if (props.modelValue) {
		emit('update:modelValue', { ...props.modelValue, policy });
	}
}

/** Return the display name for one scheduling program. */
function programName(id: string): string {
	return props.programs.find((program) => program.id === id)?.name ?? 'Unknown program';
}
</script>

<template>
	<div id="channel-default-filler" class="channel-filler-settings layer-boundary-grid">
		<fieldset>
			<legend>Channel fallback filler</legend>
			<p class="layer-boundary-description">
				Covers remaining gaps after tail filler, including authored no-program slots.
			</p>
			<label class="check-row boundary-unlimited-control">
				<input
					type="checkbox"
					:checked="modelValue !== null"
					:disabled="!modelValue && fillerPrograms.length === 0"
					@change="toggleFiller(($event.target as HTMLInputElement).checked)"
				/>
				<span>Configure channel filler</span>
			</label>
			<template v-if="modelValue">
				<label><span>Program</span>
					<span class="channel-filler-program-control">
						<select
							:value="modelValue.programId"
							@change="updateProgram(($event.target as HTMLSelectElement).value)"
						>
							<option v-for="program in fillerPrograms" :key="program.id" :value="program.id">
								{{ program.name }}
							</option>
						</select>
						<button
							type="button"
							class="toolbar-button"
							:aria-label="`Edit ${programName(modelValue.programId)}`"
							@click="emit('edit-program', modelValue.programId)"
						>
							<Pencil :size="16" />Edit
						</button>
					</span>
				</label>
				<label><span>Fitting Behavior</span>
					<select
						:value="canonicalFillerPolicy(modelValue.policy)"
						@change="updatePolicy(($event.target as HTMLSelectElement).value as FillerConfig['policy'])"
					>
						<option value="next-truncate">Allow Truncation</option>
						<option value="next-fit-only">Whole Items Only</option>
					</select>
				</label>
			</template>
		</fieldset>
	</div>
</template>
