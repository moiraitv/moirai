import { createPinia } from 'pinia';
import { createApp, watch } from 'vue';
import App from './App.vue';
import { api, onApiUnauthorized } from './api';
import { authenticationNavigationRedirect } from './authentication-navigation';
import { liveEvents } from './live-events';
import { router } from './router';
import { useAuthenticationStore } from './stores/authentication';
import './styles/main.scss';

const pinia = createPinia();
const application = createApp(App).use(pinia).use(router);
const authentication = useAuthenticationStore(pinia);

/** Leave the protected shell when HTTP or live-event traffic reveals an invalid session. */
function handleAuthenticationExpiry(): void {
	authentication.markAnonymous();
	void router.replace({ path: '/login', query: { returnTo: router.currentRoute.value.fullPath } });
}

/** Return authoritative session validity while preserving retries during HTTP outages. */
async function probeAuthentication(signal: AbortSignal): Promise<boolean | null> {
	try {
		return (await api.authenticationState(signal)).status === 'authenticated';
	}
	catch {
		return null;
	}
}

router.beforeEach(async (target) => {
	await authentication.load();
	return authenticationNavigationRedirect(
		authentication.authenticated,
		authentication.initialized,
		target,
	) ?? true;
});

onApiUnauthorized(handleAuthenticationExpiry);
liveEvents.onAuthenticationExpired(handleAuthenticationExpiry);
liveEvents.onAuthenticationProbe(probeAuthentication);
watch(
	() => authentication.authenticated,
	(value) => value ? liveEvents.start() : liveEvents.stop(),
	{ immediate: true },
);

application.mount('#app');
window.addEventListener('beforeunload', () => liveEvents.stop(), { once: true });
