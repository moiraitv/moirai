import { computed, onMounted, onScopeDispose, ref, shallowRef, watch } from 'vue';
import type { SchedulingProgram } from '@moirai/shared';
import { api } from '../../api';
import { errorMessage } from '../../error-message';
import { useChannelsStore } from '../../stores/channels';
import { useLibrariesStore } from '../../stores/libraries';

/** Draft lifecycle owned by the editor while the saved definitions load. */
interface ProgramEditorBootstrapOptions {
	identity: () => string | null | undefined;
	onStart: () => void;
	restoreDraft: (program?: SchedulingProgram) => Promise<void>;
	onDraftReady: (program?: SchedulingProgram) => void;
}

/** Resolve the current Program and open its draft independently of catalog health. */
export function useProgramEditorBootstrap(options: ProgramEditorBootstrapOptions) {
	const libraries = useLibrariesStore();
	const channels = useChannelsStore();
	const initialLoading = ref(true);
	const initialError = ref('');
	const missingProgram = ref(false);
	const editorReady = computed(() => !initialLoading.value && !initialError.value && !missingProgram.value);
	const editorOpen = computed(() => options.identity() !== undefined);
	const savedIdentity = ref<string | null>(null);
	const editingId = computed(() => savedIdentity.value ?? options.identity() ?? null);
	const programs = shallowRef<SchedulingProgram[]>([]);
	const editorBaseline = computed(() => programs.value.find(program => program.id === editingId.value));
	let sequence = 0;

	/** Restore the latest requested draft only after its saved definitions and libraries arrive. */
	async function loadEditor(): Promise<void> {
		const owner = ++sequence;
		const id = editingId.value;
		initialLoading.value = true;
		initialError.value = '';
		missingProgram.value = false;
		options.onStart();
		try {
			const [definitions] = await Promise.all([
				api.programs(), libraries.ensureLoaded(),
				channels.capabilitiesLoaded ? Promise.resolve() : channels.loadCapabilities(true),
			]);
			if (owner !== sequence) {
				return;
			}
			if (!libraries.loaded) {
				throw new Error(libraries.error || 'Could not load libraries.');
			}

			programs.value = definitions;
			const baseline = editorBaseline.value;
			if (id && !baseline) {
				missingProgram.value = true;
				return;
			}
			await options.restoreDraft(baseline);
			if (owner === sequence) {
				options.onDraftReady(baseline);
			}
		}
		catch (cause) {
			if (owner === sequence) {
				initialError.value = errorMessage(cause);
			}
		}
		finally {
			if (owner === sequence) {
				initialLoading.value = false;
			}
		}
	}

	watch(options.identity, id => {
		if (id !== undefined && (id === null || id !== savedIdentity.value)) {
			savedIdentity.value = null;
			void loadEditor();
		}
	});
	onMounted(() => void loadEditor());
	onScopeDispose(() => {
		sequence += 1;
	});
	return { editingId, savedIdentity, editorReady, editorOpen, initialLoading, initialError, missingProgram, programs, editorBaseline, loadEditor };
}
