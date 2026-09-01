<script setup lang="ts">
import { computed, nextTick, onMounted, ref, useTemplateRef } from 'vue';
import { Check, ListPlus, Plus, X } from '@lucide/vue';
import {
	type ProgramItemAddition,
	type ProgramItemAdditionResult,
	type SchedulingProgram,
	type SelectionStrategy,
} from '@moirai/shared';
import {
	programItemAdditionConfirmationDetailsSchema,
	type ProgramItemAdditionConfirmationItem,
} from '@moirai/shared/api-contracts';
import { api, ApiError } from '../../api';
import { errorMessage } from '../../error-message';
import { useSchedulingStore } from '../../stores/scheduling';
import LoadingState from '../LoadingState.vue';
import ProgramAdditionConfirmationModal from './ProgramAdditionConfirmationModal.vue';

/** Server-calculated counts that must be confirmed for a large existing-program addition. */
interface ProgramAdditionConfirmationCounts {
	addedItemCount: number;
	alreadySelectedCount: number;
	confirmationToken: string;
	items: ProgramItemAdditionConfirmationItem[];
}

/** Addition request retained while the administrator reviews its exact current mutation. */
interface PendingProgramAdditionConfirmation extends ProgramAdditionConfirmationCounts {
	addition: ProgramItemAddition;
	programName: string;
}

/** Browser-storage prefix for each library's most recently successful program destination. */
const LAST_PROGRAM_STORAGE_PREFIX = 'moirai.ui.last-program-destination.v1.';
/** In-memory fallback when browser storage is unavailable. */
const volatileLastProgramIds = new Map<string, string>();

/** Read the last successful destination for one library without requiring browser storage. */
function recalledProgramId(libraryId: string): string | undefined {
	try {
		return globalThis.localStorage.getItem(`${LAST_PROGRAM_STORAGE_PREFIX}${libraryId}`)
			?? volatileLastProgramIds.get(libraryId);
	}
	catch {
		return volatileLastProgramIds.get(libraryId);
	}
}

/** Remember the last successful destination for future additions from the same library. */
function rememberProgramId(libraryId: string, programId: string): void {
	volatileLastProgramIds.set(libraryId, programId);
	try {
		globalThis.localStorage.setItem(`${LAST_PROGRAM_STORAGE_PREFIX}${libraryId}`, programId);
	}
	catch {
		// The in-memory value still preserves the preference for this application session.
	}
}

const props = defineProps<{
	libraryId: string;
	libraryName?: string;
	selection: ProgramItemAddition['selection'];
}>();
const emit = defineEmits<{
	added: [result: ProgramItemAdditionResult];
	close: [];
}>();
const scheduling = useSchedulingStore();
const dialog = useTemplateRef<HTMLElement>('dialog');
const loading = ref(true);
const loadError = ref('');
const saving = ref(false);
const confirmationBusy = ref(false);
const error = ref('');
const pendingConfirmation = ref<PendingProgramAdditionConfirmation | null>(null);
const destinationType = ref<'existing' | 'new'>('existing');
const programId = ref('');
const name = ref('');
const strategy = ref<SelectionStrategy['type']>('sequential');
const compatiblePrograms = computed(() =>
	(scheduling.overview?.programs ?? []).filter((program) =>
		program.config.type === 'content'
		&& program.config.source.type === 'collection'
		&& program.config.source.libraryId === props.libraryId));
const selectedProgram = computed(() =>
	compatiblePrograms.value.find((program) => program.id === programId.value));
const selectionLabel = computed(() => props.selection.type === 'items'
	? `${props.selection.itemIds.length.toLocaleString()} selected ${props.selection.itemIds.length === 1 ? 'item' : 'items'}`
	: 'All matching items');

/** Return the number of items already referenced by a compatible selected-items program. */
function programItemCount(program: SchedulingProgram): number {
	return program.config.type === 'content' && program.config.source.type === 'collection'
		? program.config.source.itemIds.length
		: 0;
}

/** Return a large-addition challenge only when it has the stable server contract. */
function confirmationDetails(cause: unknown): ProgramAdditionConfirmationCounts | null {
	if (
		!(cause instanceof ApiError)
		|| cause.status !== 409
		|| cause.body.code !== 'program_item_confirmation_required'
	) {
		return null;
	}

	const parsed = programItemAdditionConfirmationDetailsSchema.safeParse(cause.body.details);
	return parsed.success ? parsed.data : null;
}

/** Reload compatible destinations and select the first program when one is available. */
async function loadPrograms(): Promise<void> {
	loading.value = true;
	loadError.value = '';
	error.value = '';
	try {
		await scheduling.load();
	}
	catch (cause) {
		loadError.value = errorMessage(cause);
		loading.value = false;
		return;
	}
	if (scheduling.error) {
		loadError.value = scheduling.error;
	}
	else {
		const recalledId = recalledProgramId(props.libraryId);
		const preferredProgram = compatiblePrograms.value.find((program) => program.id === recalledId)
			?? compatiblePrograms.value[0];
		if (preferredProgram) {
			programId.value = preferredProgram.id;
			destinationType.value = 'existing';
		}
		else {
			destinationType.value = 'new';
		}
	}
	loading.value = false;
}

/** Remember a successful destination before handing the result back to the library page. */
function finishAddition(result: ProgramItemAdditionResult): void {
	rememberProgramId(props.libraryId, result.program.id);
	emit('added', result);
}

/** Submit the selected destination and preserve the dialog for recoverable failures. */
async function addItems(): Promise<void> {
	if (saving.value) {
		return;
	}

	error.value = '';
	if (destinationType.value === 'existing' && !selectedProgram.value) {
		error.value = 'Choose a destination program.';
		return;
	}
	if (destinationType.value === 'new' && !name.value.trim()) {
		error.value = 'Enter a program name.';
		return;
	}

	const destination: ProgramItemAddition['destination'] = destinationType.value === 'existing'
		? { type: 'existing', programId: programId.value }
		: {
			type: 'new',
			name: name.value,
			strategy: strategy.value === 'sequential'
				? { type: 'sequential' }
				: { type: strategy.value, seed: '' },
		};
	saving.value = true;
	try {
		const addition: ProgramItemAddition = {
			destination,
			selection: props.selection,
		};
		try {
			const result = await api.addLibraryItemsToProgram(props.libraryId, addition);
			finishAddition(result);
		}
		catch (cause) {
			const details = destination.type === 'existing' ? confirmationDetails(cause) : null;
			if (!details) {
				throw cause;
			}

			pendingConfirmation.value = {
				addition,
				programName: selectedProgram.value?.name ?? 'this program',
				...details,
			};
		}
	}
	catch (cause) {
		error.value = errorMessage(cause);
	}
	finally {
		saving.value = false;
	}
}

/** Commit the server-counted addition after the administrator confirms the themed dialog. */
async function confirmPendingAddition(): Promise<void> {
	const pending = pendingConfirmation.value;
	if (!pending || confirmationBusy.value) {
		return;
	}

	confirmationBusy.value = true;
	error.value = '';
	try {
		const result = await api.addLibraryItemsToProgram(props.libraryId, {
			...pending.addition,
			confirmedAdditionToken: pending.confirmationToken,
		});
		finishAddition(result);
	}
	catch (cause) {
		pendingConfirmation.value = null;
		error.value = confirmationDetails(cause)
			? 'The selection changed. Submit again to review the current addition.'
			: errorMessage(cause);
		await nextTick();
		dialog.value?.focus();
	}
	finally {
		confirmationBusy.value = false;
	}
}

/** Dismiss large-addition confirmation and restore focus to the destination dialog. */
async function cancelPendingConfirmation(): Promise<void> {
	if (confirmationBusy.value) {
		return;
	}

	pendingConfirmation.value = null;
	await nextTick();
	dialog.value?.focus();
}

/** Select one compatible existing program as the destination. */
function selectProgram(id: string): void {
	programId.value = id;
	destinationType.value = 'existing';
}

/** Close the dialog only when no program mutation is in flight. */
function close(): void {
	if (!saving.value && !confirmationBusy.value && !pendingConfirmation.value) {
		emit('close');
	}
}

onMounted(async () => {
	await Promise.all([loadPrograms(), nextTick()]);
	dialog.value?.focus();
});
</script>

<template>
	<div class="moirai-dialog-backdrop program-item-modal-backdrop" @click.self="close">
		<section
			ref="dialog"
			class="moirai-dialog program-item-modal"
			role="dialog"
			aria-modal="true"
			aria-labelledby="program-item-modal-title"
			:aria-hidden="pendingConfirmation ? 'true' : undefined"
			:inert="pendingConfirmation !== null"
			tabindex="-1"
			@keydown.esc="close"
		>
			<header class="program-item-modal-header">
				<div>
					<p class="eyebrow">{{ libraryName || 'Library' }}</p>
					<h2 id="program-item-modal-title">Add to program</h2>
					<p>{{ selectionLabel }}</p>
				</div>
				<button type="button" class="icon-button" aria-label="Close" :disabled="saving || pendingConfirmation !== null" @click="close">
					<X :size="20" />
				</button>
			</header>

			<LoadingState v-if="loading" label="Loading selected-items programs…" />
			<div v-else-if="loadError" class="program-item-modal-load-error">
				<p class="notice error">{{ loadError }}</p>
				<button type="button" class="button secondary" @click="loadPrograms">Retry</button>
			</div>
			<form v-else class="program-item-modal-body" @submit.prevent="addItems">
				<p v-if="error" class="notice error">{{ error }}</p>
				<fieldset class="program-destination-options">
					<legend>Destination</legend>
					<label
						v-for="program in compatiblePrograms"
						:key="program.id"
						:class="{ selected: destinationType === 'existing' && programId === program.id }"
					>
						<input
							type="radio"
							name="program-destination"
							:value="program.id"
							:checked="destinationType === 'existing' && programId === program.id"
							@change="selectProgram(program.id)"
						/>
						<span class="program-destination-icon"><ListPlus :size="19" /></span>
						<span><strong>{{ program.name }}</strong><small>{{ programItemCount(program).toLocaleString() }} items</small></span>
						<Check v-if="destinationType === 'existing' && programId === program.id" :size="18" />
					</label>
					<label class="program-create-option" :class="{ selected: destinationType === 'new' }">
						<input type="radio" name="program-destination" value="new" :checked="destinationType === 'new'" @change="destinationType = 'new'" />
						<span class="program-destination-icon"><Plus :size="19" /></span>
						<span><strong>Create a new program</strong><small>Start a selected-items program for this library</small></span>
						<Check v-if="destinationType === 'new'" :size="18" />
					</label>
				</fieldset>

				<div v-if="destinationType === 'new'" class="program-create-fields">
					<label><span>Program name</span><input v-model="name" maxlength="120" autocomplete="off" autocapitalize="words" /></label>
					<label><span>Playback order</span><select v-model="strategy"><option value="sequential">Sequential</option><option value="shuffle">Shuffle</option><option value="random">Random</option><option value="weighted-random">Weighted random</option></select></label>
				</div>

				<footer class="program-item-modal-footer">
					<button type="button" class="button secondary" :disabled="saving" @click="close">Cancel</button>
					<button class="button" type="submit" :disabled="saving || (destinationType === 'existing' && !selectedProgram)">
						{{ saving ? 'Adding…' : 'Add to program' }}
					</button>
				</footer>
			</form>
		</section>
		<ProgramAdditionConfirmationModal
			v-if="pendingConfirmation"
			:program-name="pendingConfirmation.programName"
			:already-selected-count="pendingConfirmation.alreadySelectedCount"
			:items="pendingConfirmation.items"
			:busy="confirmationBusy"
			@cancel="cancelPendingConfirmation"
			@confirm="confirmPendingAddition"
		/>
	</div>
</template>
