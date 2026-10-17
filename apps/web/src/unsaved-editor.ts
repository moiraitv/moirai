import { requestUnsavedChanges } from './confirmation';

/** State and callbacks required to close one save-capable editor safely. */
export interface UnsavedEditorCloseOptions {
	blocked?: boolean;
	retainedDraft?: { flush: () => Promise<boolean>; clear: () => void };
	isDirty?: () => boolean;
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

	if (!options.dirty || (options.retainedDraft && await options.retainedDraft.flush())) {
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
		if (options.retainedDraft && options.isDirty && !options.isDirty()) {
			await options.discard();
		}
	}
	else if (resolution === 'discard') {
		options.retainedDraft?.clear();
		await options.discard();
	}
}

/** Resolve failed recovery before navigation without dismissing or redirecting an accepted route. */
export async function confirmDraftNavigation(options: Omit<UnsavedEditorCloseOptions, 'discard'>): Promise<boolean> {
	let proceed = false;
	await closeUnsavedEditor({ ...options, discard: () => {
		proceed = true;
	} });
	return proceed;
}
