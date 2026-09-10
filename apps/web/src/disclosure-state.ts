import { ref, watch, type Ref } from 'vue';

/** Remember one disclosure per browser without requiring storage to be available. */
export function useDisclosureState(key: string, defaultOpen = false): Ref<boolean> {
	const storageKey = `moirai.ui.disclosure.${key}.v1`;
	let initial = defaultOpen;
	try {
		const saved = globalThis.localStorage?.getItem(storageKey);
		if (saved === 'true' || saved === 'false') {
			initial = saved === 'true';
		}
	}
	catch {
		// Private browsing or browser policy may prevent access to storage.
	}

	const open = ref(initial);
	watch(open, (value) => {
		try {
			globalThis.localStorage?.setItem(storageKey, String(value));
		}
		catch {
			// Keep the disclosure usable even when its preference cannot be saved.
		}
	}, { flush: 'sync' });
	return open;
}
