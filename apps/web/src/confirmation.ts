import { shallowRef } from 'vue';

/** User-facing content and behavior for one asynchronous confirmation request. */
export interface ConfirmationOptions {
	key?: string;
	title: string;
	message: string;
	confirmLabel?: string;
	destructive?: boolean;
}

/** Complete modal options exposed to the application shell. */
interface ResolvedConfirmationOptions extends ConfirmationOptions {
	instanceId: number;
	confirmLabel: string;
	destructive: boolean;
}

/** Queued confirmation paired with its eventual caller result. */
interface PendingConfirmation {
	options: ResolvedConfirmationOptions;
	promise: Promise<boolean>;
	resolve: (confirmed: boolean) => void;
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
export function requestConfirmation(options: ConfirmationOptions): Promise<boolean> {
	const duplicate = [active, ...queue].find((request) =>
		request?.options.key !== undefined && request.options.key === options.key);
	if (duplicate) {
		return Promise.resolve(false);
	}

	let resolve!: (confirmed: boolean) => void;
	const promise = new Promise<boolean>((result) => {
		resolve = result;
	});
	queue.push({
		options: {
			...options,
			instanceId: nextInstanceId++,
			confirmLabel: options.confirmLabel ?? 'Confirm',
			destructive: options.destructive ?? false,
		},
		promise,
		resolve,
	});
	activateNextConfirmation();
	return promise;
}

/** Resolve the visible confirmation and advance any independently queued request. */
export function settleConfirmation(confirmed: boolean): void {
	const completed = active;
	if (!completed) {
		return;
	}

	active = null;
	activeConfirmation.value = null;
	completed.resolve(confirmed);
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
		request.resolve(false);
	}
}
