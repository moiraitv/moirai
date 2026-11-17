import { computed, ref, watch } from 'vue';
import { onBeforeRouteLeave, onBeforeRouteUpdate, useRoute, useRouter } from 'vue-router';

/** Library modals resolve their own draft before the owning page accepts navigation. */
interface LibraryEditor {
	confirmNavigation: () => Promise<boolean>;
}

/** Keep one library editor mounted while creation adopts the saved settings route. */
export function useLibraryEditorRoute() {
	const route = useRoute();
	const router = useRouter();
	const editor = ref<LibraryEditor>();
	const revision = ref(0);
	const creating = computed(() => route.path === '/libraries/new');
	const open = computed(() => creating.value || route.path.endsWith('/settings'));
	let adopting = false;
	let leaving = false;

	/** Resolve a draft before replacing its resource or accepting a different destination. */
	async function confirmNavigation(): Promise<boolean> {
		if (adopting) {
			return true;
		}

		leaving = true;
		try {
			return await editor.value?.confirmNavigation() ?? true;
		}
		finally {
			leaving = false;
		}
	}

	onBeforeRouteLeave(confirmNavigation);
	onBeforeRouteUpdate((to, from) => to.path === from.path || confirmNavigation());
	watch(() => route.path, () => {
		if (!adopting) {
			revision.value += 1;
		}
	}, { flush: 'sync' });

	/** Adopt the saved permalink without interrupting the dialog or an accepted departure. */
	async function adopt(id: string): Promise<void> {
		if (leaving) {
			return;
		}

		adopting = true;
		try {
			await router.replace({ path: `/libraries/${id}/settings`, query: route.query });
		}
		finally {
			adopting = false;
		}
	}

	/** Return to the owning catalog once the modal has resolved its draft. */
	async function close(): Promise<void> {
		if (open.value) {
			await router.push({ path: creating.value ? '/libraries' : `/libraries/${String(route.params.id)}`, query: route.query });
		}
	}

	return { editor, open, creating, revision, close, adopt };
}
