import { ref, type Ref } from 'vue';
import type { SchedulingProgram } from '@moirai/shared';
import { api } from '../../api';
import { requestConfirmation } from '../../confirmation';

/** Dependencies owned by the program editor while shared resource actions execute. */
interface ProgramResourceActionOptions {
	program: () => SchedulingProgram | undefined;
	embedded: () => boolean;
	saving: () => boolean;
	resetDraft: (program?: SchedulingProgram) => void;
	reloadDraft: () => Promise<void>;
	onDeleted: () => Promise<void>;
	onError: (cause: unknown) => void;
}

/** Reset or permanently delete the program represented by one editor instance. */
export interface ProgramResourceActions {
	deleting: Ref<boolean>;
	resetProgram: () => Promise<void>;
	deleteProgram: () => Promise<void>;
}

/** Own program reset and standalone deletion without expanding the editor coordinator. */
export function useProgramResourceActions(
	options: ProgramResourceActionOptions,
): ProgramResourceActions {
	const deleting = ref(false);

	/** Restore the program draft and its dependent source data to the opening baseline. */
	async function resetProgram(): Promise<void> {
		options.resetDraft(options.program());
		await options.reloadDraft();
	}

	/** Confirm and delete the standalone program being edited. */
	async function deleteProgram(): Promise<void> {
		const program = options.program();
		if (
			options.embedded()
			|| !program
			|| options.saving()
			|| deleting.value
			|| !(await requestConfirmation({
				key: `delete-program:${program.id}`,
				title: 'Delete Program?',
				message: `Delete ${program.name} and discard any unsaved changes? This cannot be undone.`,
				confirmLabel: 'Delete Program',
				destructive: true,
			}))
		) {
			return;
		}

		deleting.value = true;
		try {
			await api.deleteProgram(program.id);
			await options.onDeleted();
		}
		catch (cause) {
			options.onError(cause);
		}
		finally {
			deleting.value = false;
		}
	}

	return { deleting, resetProgram, deleteProgram };
}
