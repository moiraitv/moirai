<script setup lang="ts">
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

/** Enable channel fallback filler with the first program, or remove its configuration. */
function toggleFiller(enabled: boolean): void {
	const programId = props.programs[0]?.id;
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
				Used for authored no-program slots and programmed slots that inherit filler without a
				template default.
			</p>
			<label class="check-row boundary-unlimited-control">
				<input
					type="checkbox"
					:checked="modelValue !== null"
					:disabled="programs.length === 0"
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
							<option v-for="program in programs" :key="program.id" :value="program.id">
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
				<label><span>Selection policy</span>
					<select
						:value="modelValue.policy"
						@change="updatePolicy(($event.target as HTMLSelectElement).value as FillerConfig['policy'])"
					>
						<option value="best-fit-or-truncate">Best fit or truncate</option>
						<option value="best-fit-only">Best fit only</option>
						<option value="next-truncate">Next and truncate</option>
						<option value="next-fit-only">Next only if it fits</option>
					</select>
				</label>
			</template>
		</fieldset>
	</div>
</template>
