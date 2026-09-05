<script setup lang="ts">
import QuickStepActions from './QuickStepActions.vue';
import type { Library, LibraryCreate, QuickChannelScenario } from '@moirai/shared';
import { libraryCreateSchema } from '@moirai/shared';
import { computed } from 'vue';
import { FolderPlus, Library as LibraryIcon } from '@lucide/vue';

const props = defineProps<{
	scenario: QuickChannelScenario;
	libraries: Library[];
	busy: boolean;
	error: string;
}>();
const mode = defineModel<'existing' | 'new'>('mode', { required: true });
const libraryId = defineModel<string>('libraryId', { required: true });
const newLibrary = defineModel<LibraryCreate>('newLibrary', { required: true });
const emit = defineEmits<{ back: []; next: []; create: [] }>();
const newLibraryValid = computed(() => libraryCreateSchema.safeParse(newLibrary.value).success);
const canContinue = computed(() => mode.value === 'existing'
	? props.libraries.some((library) => library.id === libraryId.value)
	: newLibraryValid.value);
</script>

<template>
	<section class="quick-step" aria-labelledby="quick-library-title">
		<div class="quick-step-heading">
			<p class="eyebrow">Step 1 of 4</p>
			<h2 id="quick-library-title">Choose a media library</h2>
			<p>Use an existing compatible library or add a folder and begin scanning it now.</p>
		</div>
		<div class="quick-choice-tabs" role="radiogroup" aria-label="Library choice">
			<button
				type="button"
				:class="{ active: mode === 'existing' }"
				:disabled="libraries.length === 0"
				@click="mode = 'existing'"
			>
				<LibraryIcon :size="18" />Existing library
			</button>
			<button type="button" :class="{ active: mode === 'new' }" @click="mode = 'new'">
				<FolderPlus :size="18" />Create new
			</button>
		</div>
		<div v-if="mode === 'existing'" class="panel form-grid quick-library-panel">
			<label class="span-2">
				<span>Library</span>
				<select v-model="libraryId">
					<option v-for="library in libraries" :key="library.id" :value="library.id">
						{{ library.name }} · {{ library.itemCount.toLocaleString() }} indexed
					</option>
				</select>
			</label>
		</div>
		<div v-else class="panel form-grid quick-library-panel">
			<label><span>Name</span><input v-model="newLibrary.name" required autocapitalize="words" /></label>
			<label><span>Path Moirai scans</span><input v-model="newLibrary.sourceConfig.scanRoot" required /></label>
			<label class="check span-2">
				<input v-model="newLibrary.watcherEnabled" type="checkbox" />Watch for changes
			</label>
		</div>
		<p v-if="error" class="notice error">{{ error }}</p>
		<QuickStepActions>
			<button class="button secondary" type="button" :disabled="busy" @click="emit('back')">Back</button>
			<button
				class="button"
				type="button"
				:disabled="busy || !canContinue"
				@click="mode === 'new' ? emit('create') : emit('next')"
			>
				{{ busy ? 'Creating and scanning…' : mode === 'new' ? 'Create and Continue' : 'Continue' }}
			</button>
		</QuickStepActions>
	</section>
</template>
