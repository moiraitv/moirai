import { describe, expect, it } from 'vitest';
import {
	activeConfirmation,
	cancelConfirmations,
	requestConfirmation,
	requestUnsavedChanges,
	settleConfirmation,
} from '@web/confirmation.js';

describe('application confirmations', () => {
	it('queues independent requests without authorizing duplicate callers', async () => {
		const first = requestConfirmation({
			key: 'delete-program:one',
			title: 'Delete Program?',
			message: 'Delete the program?',
			destructive: true,
		});
		const duplicate = requestConfirmation({
			key: 'delete-program:one',
			title: 'Ignored Duplicate',
			message: 'This request should not share the first result.',
		});
		const second = requestConfirmation({
			key: 'discard-template:two',
			title: 'Discard Changes?',
			message: 'Discard the template changes?',
			confirmLabel: 'Discard Changes',
		});

		expect(duplicate).not.toBe(first);
		await expect(duplicate).resolves.toBe(false);
		expect(activeConfirmation.value).toMatchObject({
			title: 'Delete Program?',
			confirmLabel: 'Confirm',
			destructive: true,
		});

		settleConfirmation('confirm');
		await expect(first).resolves.toBe(true);
		expect(activeConfirmation.value).toMatchObject({
			title: 'Discard Changes?',
			confirmLabel: 'Discard Changes',
			destructive: false,
		});

		settleConfirmation('cancel');
		await expect(second).resolves.toBe(false);
		expect(activeConfirmation.value).toBeNull();
	});

	it('distinguishes saving, discarding, and cancelling unsaved editor changes', async () => {
		const save = requestUnsavedChanges({
			key: 'unsaved-program:one',
			message: 'Save this program before closing?',
		});
		expect(activeConfirmation.value).toMatchObject({
			confirmLabel: 'Save Changes',
			alternateLabel: 'Discard Changes',
			alternateDestructive: true,
		});
		settleConfirmation('confirm');
		await expect(save).resolves.toBe('save');

		const discard = requestUnsavedChanges({
			key: 'unsaved-template:one',
			message: 'Save this template before closing?',
		});
		settleConfirmation('alternate');
		await expect(discard).resolves.toBe('discard');

		const cancel = requestUnsavedChanges({
			key: 'unsaved-channel:one',
			message: 'Save this channel before closing?',
		});
		settleConfirmation('cancel');
		await expect(cancel).resolves.toBe('cancel');
	});

	it('cancels active and queued actions when navigation abandons their workflow', async () => {
		const active = requestConfirmation({
			key: 'delete-library:one',
			title: 'Delete Library?',
			message: 'Delete the library?',
		});
		const queued = requestConfirmation({
			key: 'delete-channel:two',
			title: 'Delete Channel?',
			message: 'Delete the channel?',
		});

		cancelConfirmations();

		await expect(active).resolves.toBe(false);
		await expect(queued).resolves.toBe(false);
		expect(activeConfirmation.value).toBeNull();
	});
});
