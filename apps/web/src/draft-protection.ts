import { onScopeDispose, watch, type WatchSource } from 'vue';
import { requestConfirmation } from './confirmation';

/** Active drafts also protect sign-out before it revokes the authenticated session. */
const drafts = new Set<() => boolean>();

/** Register native unload protection only while this owner has an unsaved draft. */
export function useDraftProtection(dirty: () => boolean): void {
	drafts.add(dirty);
	const beforeUnload = (event: BeforeUnloadEvent): void => {
		if (dirty()) {
			event.preventDefault();
			event.returnValue = '';
		}
	};
	watch(dirty as WatchSource<boolean>, (pending) => {
		window.removeEventListener('beforeunload', beforeUnload);
		if (pending) {
			window.addEventListener('beforeunload', beforeUnload);
		}
	}, { immediate: true });
	onScopeDispose(() => {
		drafts.delete(dirty);
		window.removeEventListener('beforeunload', beforeUnload);
	});
}

/** Ask before an explicit sign-out discards any active page or nested editor draft. */
export async function confirmSignOut(): Promise<boolean> {
	return ![...drafts].some((dirty) => dirty()) || requestConfirmation({
		key: 'sign-out-drafts',
		title: 'Discard Unsaved Changes?',
		message: 'Sign out without saving your changes?',
		confirmLabel: 'Discard Changes and Sign Out',
		destructive: true,
	});
}
