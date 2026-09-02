import { requestUnsavedChanges } from './confirmation';

/** State and callbacks required to close one save-capable editor safely. */
export interface UnsavedEditorCloseOptions {
	blocked?: boolean;
	dirty: boolean;
	key: string;
	message: string;
	saveLabel?: string;
	save: () => unknown | Promise<unknown>;
	discard: () => unknown | Promise<unknown>;
}

/** Save, discard, or retain an editor according to the user's modal choice. */
export async function closeUnsavedEditor(options: UnsavedEditorCloseOptions): Promise<void> {
	if (options.blocked) {
		return;
	}

	if (!options.dirty) {
		await options.discard();
		return;
	}

	const resolution = await requestUnsavedChanges({
		key: options.key,
		message: options.message,
		...(options.saveLabel ? { saveLabel: options.saveLabel } : {}),
	});
	if (resolution === 'save') {
		await options.save();
	}
	else if (resolution === 'discard') {
		await options.discard();
	}
}
