import { computed, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

/** Keep a mounted panel's selection reloadable without discarding its draft on tab changes. */
export function useRouteTab<T extends string>(tabs: readonly T[], fallback: T, enabled: () => boolean = () => true) {
	const route = useRoute();
	const router = useRouter();
	const selected = computed({
		get: () => {
			const tab = route.query.tab;
			return typeof tab === 'string' && tabs.includes(tab as T) ? tab as T : fallback;
		},
		set: (tab: T) => {
			if (enabled() && tabs.includes(tab) && tab !== selected.value) {
				void router.push({ path: route.path, query: { ...route.query, tab }, hash: route.hash });
			}
		},
	});

	// Replace missing or unsupported values so even the initial/default panel has a permalink.
	watch(() => [enabled(), route.path, route.query.tab], () => {
		if (enabled() && route.query.tab !== selected.value) {
			void router.replace({ path: route.path, query: { ...route.query, tab: selected.value }, hash: route.hash });
		}
	}, { immediate: true });
	return selected;
}
