import { afterEach, describe, expect, it, vi } from 'vitest';
import { activeConfirmation, cancelConfirmations, settleConfirmation } from '@web/confirmation.js';
import { closeUnsavedEditor } from '@web/unsaved-editor.js';

afterEach(() => cancelConfirmations());

describe('unsaved editor closing', () => {
	it('closes a clean editor without prompting', async () => {
		const save = vi.fn();
		const discard = vi.fn();

		await closeUnsavedEditor({ dirty: false, key: 'clean', message: 'Save?', save, discard });

		expect(activeConfirmation.value).toBeNull();
		expect(save).not.toHaveBeenCalled();
		expect(discard).toHaveBeenCalledOnce();
	});

	it.each([
		['confirm', 'save'],
		['alternate', 'discard'],
		['cancel', 'neither'],
	] as const)('honors the %s decision', async (resolution, expected) => {
		const save = vi.fn();
		const discard = vi.fn();
		const closing = closeUnsavedEditor({
			dirty: true,
			key: `dirty-${resolution}`,
			message: 'Save before closing?',
			save,
			discard,
		});

		expect(activeConfirmation.value).not.toBeNull();
		settleConfirmation(resolution);
		await closing;

		expect(save).toHaveBeenCalledTimes(expected === 'save' ? 1 : 0);
		expect(discard).toHaveBeenCalledTimes(expected === 'discard' ? 1 : 0);
	});
});

it('closes retained work without treating the dismissal as a discard', async () => {
	const clear = vi.fn();
	const dismiss = vi.fn();
	const flush = vi.fn(async () => true);
	await closeUnsavedEditor({ dirty: true, key: 'retained', message: 'Save?',
		retainedDraft: { flush, clear }, save: vi.fn(), discard: dismiss });
	expect(flush).toHaveBeenCalledOnce();
	expect(clear).not.toHaveBeenCalled();
	expect(dismiss).toHaveBeenCalledOnce();
	expect(activeConfirmation.value).toBeNull();
});

it('keeps save/discard protection when retaining work fails', async () => {
	const clear = vi.fn();
	const dismiss = vi.fn();
	const closing = closeUnsavedEditor({ dirty: true, key: 'failed-retention', message: 'Save?',
		retainedDraft: { flush: async () => false, clear }, save: vi.fn(), discard: dismiss });
	await vi.waitFor(() => expect(activeConfirmation.value).not.toBeNull());
	settleConfirmation('alternate');
	await closing;
	expect(clear).toHaveBeenCalledOnce();
	expect(dismiss).toHaveBeenCalledOnce();
});
