import { computed, ref } from 'vue';
import { onBeforeRouteLeave, onBeforeRouteUpdate, useRoute, useRouter } from 'vue-router';

/** Library modals resolve their own draft before the owning page accepts navigation. */
interface LibraryEditor {
	confirmNavigation: () => Promise<boolean>;
}

/** Keep library modal identity and draft guards with the persistent routed page. */
export function useLibraryEditorRoute(kind: 'create' | 'settings') {
	const route = useRoute();
	const router = useRouter();
	const editor = ref<LibraryEditor>();
	const open = computed(() => kind === 'create' ? route.path === '/libraries/new' : route.path.endsWith('/settings'));
	onBeforeRouteLeave(() => editor.value?.confirmNavigation() ?? true);
	onBeforeRouteUpdate((to, from) => to.path === from.path || (editor.value?.confirmNavigation() ?? true));

	/** Return to the owning catalog once the modal has resolved its draft. */
	async function close(): Promise<void> {
		if (open.value) {
			await router.push({ path: kind === 'create' ? '/libraries' : `/libraries/${String(route.params.id)}`, query: route.query });
		}
	}

	return { editor, open, close };
}
