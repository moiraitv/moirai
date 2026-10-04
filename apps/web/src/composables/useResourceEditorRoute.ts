import { watch } from 'vue';
import { onBeforeRouteLeave, onBeforeRouteUpdate, useRoute, useRouter } from 'vue-router';

/** Bind a collection-owned modal to a reloadable resource or duplication route. */
interface ResourceEditorRouteOptions<T extends { id: string }> {
	basePath: () => string;
	resources: () => T[];
	ready: () => boolean;
	isOpen: () => boolean;
	open: (resource?: T, duplicate?: boolean) => unknown;
	close: () => Promise<void>;
	onMissing: () => void;
}

/** Preserve drafts during history navigation without redirecting an accepted destination. */
export function useResourceEditorRoute<T extends { id: string }>(options: ResourceEditorRouteOptions<T>) {
	const route = useRoute();
	const router = useRouter();
	let leaving = false;
	let initialized = '';

	/** Request a new, saved, or duplicated resource through ordinary guarded navigation. */
	function navigate(resource?: T, duplicate = false): Promise<unknown> {
		const query = { ...route.query, duplicate: duplicate ? resource?.id : undefined };
		return router.push({ path: `${options.basePath()}/${duplicate || !resource ? 'new' : resource.id}`, query });
	}

	/** Return to the collection after dismissal unless a route guard owns navigation. */
	function finish(): void {
		if (!leaving) {
			void router.push({ path: options.basePath(), query: { ...route.query, duplicate: undefined } });
		}
	}

	/** Let the editor resolve its draft before allowing a different route identity. */
	async function confirmNavigation(): Promise<boolean> {
		leaving = true;
		try {
			if (options.isOpen()) {
				await options.close();
			}
			return !options.isOpen();
		}
		finally {
			leaving = false;
		}
	}

	onBeforeRouteLeave(confirmNavigation);
	onBeforeRouteUpdate((to, from) => (to.path === from.path && to.query.duplicate === from.query.duplicate)
		|| confirmNavigation());
	watch(() => [route.path, route.query.duplicate, options.ready(), options.resources()], () => {
		const identity = `${route.path}:${String(route.query.duplicate ?? '')}`;
		if (!route.path.startsWith(`${options.basePath()}/`)) {
			initialized = '';
			return;
		}
		if (identity === initialized || options.isOpen()) {
			return;
		}

		const isNew = route.params.id === 'new';
		const sourceId = isNew ? route.query.duplicate : route.params.id;
		if (!isNew || sourceId) {
			if (!options.ready()) {
				return;
			}
			const resource = options.resources().find(entry => entry.id === sourceId);
			initialized = identity;
			if (!resource) {
				options.onMissing();
				return;
			}
			void options.open(resource, isNew);
		}
		else {
			initialized = identity;
			void options.open();
		}
	}, { immediate: true });

	return { navigate, finish };
}
