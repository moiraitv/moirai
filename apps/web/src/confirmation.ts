import { shallowRef } from 'vue';

/** User-facing content and behavior for one asynchronous confirmation request. */
export interface ConfirmationOptions {
	key?: string;
	title: string;
	message: string;
	confirmLabel?: string;
	destructive?: boolean;
	requiredText?: string;
	requiredTextLabel?: string;
	alternateLabel?: string;
	alternateDestructive?: boolean;
}

/** Result returned by a confirmation with primary, alternate, and cancel actions. */
export type ConfirmationResolution = 'confirm' | 'alternate' | 'cancel';

/** User choice when closing an editor with unsaved changes. */
export type UnsavedChangesResolution = 'save' | 'discard' | 'cancel';

/** Copy and identity used for one unsaved-changes prompt. */
export interface UnsavedChangesOptions {
	key: string;
	title?: string;
	message: string;
	saveLabel?: string;
}

/** Complete modal options exposed to the application shell. */
interface ResolvedConfirmationOptions extends Omit<
	ConfirmationOptions,
	'alternateLabel' | 'requiredText' | 'requiredTextLabel'
> {
	instanceId: number;
	confirmLabel: string;
	destructive: boolean;
	alternateLabel: string | null;
	alternateDestructive: boolean;
	requiredText: string | null;
	requiredTextLabel: string | null;
}

/** Queued confirmation paired with its eventual caller result. */
interface PendingConfirmation {
	options: ResolvedConfirmationOptions;
	promise: Promise<ConfirmationResolution>;
	resolve: (resolution: ConfirmationResolution) => void;
}

/** Confirmation currently presented by the application shell. */
export const activeConfirmation = shallowRef<ResolvedConfirmationOptions | null>(null);
const queue: PendingConfirmation[] = [];
let active: PendingConfirmation | null = null;
let nextInstanceId = 1;

/** Present the next queued confirmation when no other request owns the modal. */
function activateNextConfirmation(): void {
	if (active || queue.length === 0) {
		return;
	}

	active = queue.shift()!;
	activeConfirmation.value = active.options;
}

/** Ask the application shell to resolve one confirmation without blocking the browser thread. */
function enqueueConfirmation(options: ConfirmationOptions): Promise<ConfirmationResolution> {
	const duplicate = [active, ...queue].find((request) =>
		request?.options.key !== undefined && request.options.key === options.key);
	if (duplicate) {
		return Promise.resolve('cancel');
	}

	let resolve!: (resolution: ConfirmationResolution) => void;
	const promise = new Promise<ConfirmationResolution>((result) => {
		resolve = result;
	});
	queue.push({
		options: {
			...options,
			instanceId: nextInstanceId++,
			confirmLabel: options.confirmLabel ?? 'Confirm',
			destructive: options.destructive ?? false,
			alternateLabel: options.alternateLabel ?? null,
			alternateDestructive: options.alternateDestructive ?? false,
			requiredText: options.requiredText ?? null,
			requiredTextLabel: options.requiredTextLabel ?? null,
		},
		promise,
		resolve,
	});
	activateNextConfirmation();
	return promise;
}

/** Ask the application shell to resolve one binary confirmation. */
export async function requestConfirmation(options: ConfirmationOptions): Promise<boolean> {
	return await enqueueConfirmation(options) === 'confirm';
}

/** Ask whether to save, discard, or continue editing an unsaved draft. */
export async function requestUnsavedChanges(
	options: UnsavedChangesOptions,
): Promise<UnsavedChangesResolution> {
	const resolution = await enqueueConfirmation({
		key: options.key,
		title: options.title ?? 'Save Changes?',
		message: options.message,
		confirmLabel: options.saveLabel ?? 'Save Changes',
		alternateLabel: 'Discard Changes',
		alternateDestructive: true,
	});

	return resolution === 'confirm' ? 'save' : resolution === 'alternate' ? 'discard' : 'cancel';
}

/** Resolve the visible confirmation and advance any independently queued request. */
export function settleConfirmation(resolution: ConfirmationResolution): void {
	const completed = active;
	if (!completed) {
		return;
	}

	active = null;
	activeConfirmation.value = null;
	completed.resolve(resolution);
	activateNextConfirmation();
}

/** Cancel every active or queued confirmation when its surrounding workflow is abandoned. */
export function cancelConfirmations(): void {
	const cancelled = [active, ...queue].filter(
		(request): request is PendingConfirmation => request !== null,
	);
	active = null;
	queue.length = 0;
	activeConfirmation.value = null;
	for (const request of cancelled) {
		request.resolve('cancel');
	}
}
