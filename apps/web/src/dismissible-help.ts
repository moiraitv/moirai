import { ref, type Ref } from 'vue';

/** Browser-storage keys for independently dismissible help panels. */
export const DISMISSIBLE_HELP_STORAGE_KEYS = Object.freeze({
	programs: 'moirai.ui.help.programs.v1',
	templates: 'moirai.ui.help.templates.v1',
	channelSchedules: 'moirai.ui.help.channel-schedules.v1',
});

/** Storage subset used to persist whether contextual help was dismissed. */
type HelpPreferenceStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** Reactive visibility state and actions for a dismissible help panel. */
export interface DismissibleHelpState {
	visible: Ref<boolean>;
	dismiss: () => void;
	show: () => void;
}

/** Access browser storage when available without making it a hard dependency. */
function browserStorage(): HelpPreferenceStorage | undefined {
	try {
		return globalThis.localStorage;
	}
	catch {
		return undefined;
	}
}

/** Manage browser-local dismissal while remaining usable when storage access is unavailable. */
export function useDismissibleHelp(
	storageKey: string,
	storage: HelpPreferenceStorage | undefined = browserStorage(),
): DismissibleHelpState {
	let dismissed = false;
	try {
		dismissed = storage?.getItem(storageKey) === 'dismissed';
	}
	catch {
		dismissed = false;
	}

	const visible = ref(!dismissed);

	/** Persist dismissal of one help panel when storage is available. */
	function dismiss(): void {
		visible.value = false;
		try {
			storage?.setItem(storageKey, 'dismissed');
		}
		catch {
			// Visibility still applies for the current page when browser storage is unavailable.
		}
	}

	/** Restore one help panel and remove its saved dismissal. */
	function show(): void {
		visible.value = true;
		try {
			storage?.removeItem(storageKey);
		}
		catch {
			// Visibility still applies for the current page when browser storage is unavailable.
		}
	}

	return { visible, dismiss, show };
}
