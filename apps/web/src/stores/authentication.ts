import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import type { AuthenticationState } from '@moirai/shared';
import {
	api,
	ApiError,
	beginApiAuthenticationTransition,
	setApiCsrfToken,
} from '../api';

/**
 * Own browser authentication bootstrap and session transitions. Administrative stores and live
 * events use its authenticated state as their boundary for starting network activity.
 */
export const useAuthenticationStore = defineStore('authentication', () => {
	const state = ref<AuthenticationState | null>(null);
	const loading = ref(true);
	const loadError = ref('');
	let loadPromise: Promise<void> | null = null;

	const authenticated = computed(() => state.value?.status === 'authenticated');
	const initialized = computed(() => state.value !== null && state.value.status !== 'uninitialized');

	/** Apply authoritative session state and synchronize unsafe-request protection. */
	function apply(next: AuthenticationState): void {
		state.value = next;
		loadError.value = '';
		setApiCsrfToken(next.csrfToken);
	}

	/** Load current initialization and session state exactly once for concurrent callers. */
	async function load(): Promise<void> {
		if (state.value) {
			loading.value = false;
			return;
		}

		if (!loadPromise) {
			loadPromise = api.authenticationState()
				.then(apply)
				.catch(() => {
					loadError.value = 'Unable to load authentication state. Try again shortly.';
				})
				.finally(() => {
					loading.value = false;
					loadPromise = null;
				});
		}

		return loadPromise;
	}

	/** Claim an uninitialized installation with local credentials. */
	async function setup(username: string, password: string): Promise<void> {
		apply(await api.setupAuthentication({ username, password }));
	}

	/** Exchange local credentials for an administrator session. */
	async function login(username: string, password: string): Promise<void> {
		apply(await api.login({ username, password }));
	}

	/**
	 * Apply one server-issued replacement session while fencing stale failures from overlapping
	 * requests and recovering authoritative state after an ambiguous response failure.
	 */
	async function replaceBrowserSession(
		issue: () => Promise<AuthenticationState>,
	): Promise<void> {
		const finishTransition = beginApiAuthenticationTransition();
		try {
			apply(await issue());
		}
		catch (error) {
			// A lost response can hide whether the server committed and installed a replacement cookie.
			try {
				apply(await api.authenticationState());
			}
			catch {
				// Preserve the last known state when the authoritative probe is also unavailable.
			}

			throw error;
		}
		finally {
			finishTransition();
		}
	}

	/** Create or rotate the singleton local fallback account. */
	async function saveLocalCredentials(input: {
		username: string;
		password: string;
		currentPassword: string | null;
	}): Promise<void> {
		await replaceBrowserSession(() => api.saveLocalCredentials(input));
	}

	/** Consume an operator recovery code and establish the recovered local session. */
	async function recover(token: string, username: string, password: string): Promise<void> {
		await replaceBrowserSession(() => api.recoverAuthentication({ token, username, password }));
	}

	/** Revoke the current session and return an optional Logto end-session destination. */
	async function logout(): Promise<string | null> {
		const csrf = state.value?.csrfToken;
		if (!csrf) {
			markAnonymous();
			return null;
		}

		try {
			const result = await api.logout();
			markAnonymous();
			return result.redirectUrl;
		}
		catch (error) {
			if (error instanceof ApiError && error.status === 401) {
				markAnonymous();
				return null;
			}

			throw error;
		}
	}

	/** Clear authenticated state after an API request reports session expiry. */
	function markAnonymous(): void {
		if (state.value) {
			state.value = {
				...state.value,
				status: state.value.status === 'uninitialized' ? 'uninitialized' : 'anonymous',
				localUsername: null,
				identity: null,
				csrfToken: null,
			};
		}
		setApiCsrfToken(null);
	}

	return {
		state,
		loading,
		loadError,
		authenticated,
		initialized,
		load,
		setup,
		login,
		saveLocalCredentials,
		recover,
		logout,
		markAnonymous,
	};
});
