import { computed, onBeforeUnmount, ref, watch, type Ref } from 'vue';
import { savedMediaServerProbeSchema, type MediaServer, type MediaServerCreate } from '@moirai/shared';
import { api } from '../../api';
import { errorMessage } from '../../error-message';

/** Identity and libraries returned by a connection test without persisting the connection. */
export type MediaServerProbeResult = Awaited<ReturnType<typeof api.probeMediaServer>>;

/** Callbacks keep library selection and settings notifications owned by their respective editors. */
interface ConnectionOptions {
	saved: () => MediaServer | undefined;
	typeKey: () => string;
	invalidate: () => void;
}

/** Authentication paths presented independently by the connection editor. */
type AuthenticationMethod = 'saved' | 'key' | 'password' | 'plex-sign-in';

/**
 * Own temporary password/Plex credentials and non-persisting connection tests for one editor.
 * Input changes invalidate pending work; internally accepted credentials remain local to this draft.
 */
export function useMediaServerConnection(form: Ref<MediaServerCreate>, options: ConnectionOptions) {
	/** Prefer a saved credential or the provider's normal first-time sign-in method. */
	function initialMethod(): AuthenticationMethod {
		return options.saved()?.hasCredential ? 'saved' : form.value.provider === 'plex' ? 'plex-sign-in' : 'password';
	}
	const method = ref<AuthenticationMethod>(initialMethod());
	const username = ref('');
	const password = ref('');
	const passwordVisible = ref(false);
	const pinCode = ref('');
	const testing = ref(false);
	const linking = ref(false);
	const error = ref('');
	const busy = computed(() => testing.value || linking.value);
	const authDirty = computed(() => Boolean(username.value || password.value || pinCode.value) || method.value !== initialMethod());
	const canTest = computed(() => Boolean(form.value.baseUrl.trim()) && !busy.value && (
		method.value === 'password' ? Boolean(username.value.trim() && (password.value || form.value.accessToken))
			: Boolean(form.value.accessToken.trim() || (method.value === 'saved' && options.saved()?.hasCredential))
	));
	let generation = 0;
	let acceptingCredential = false;
	let derivedToken = false;
	let disposed = false;
	let pinTimer: ReturnType<typeof setTimeout> | undefined;

	/** Cancel future polls and clear the code as soon as its connection context changes. */
	function stopPin(): void {
		clearTimeout(pinTimer);
		pinTimer = undefined;
		pinCode.value = '';
		linking.value = false;
	}

	/** Invalidate pending credentials and discovery before a changed input can accept a response. */
	function invalidate(): void {
		if (acceptingCredential) {
			return;
		}

		generation += 1;
		testing.value = false;
		stopPin();
		error.value = '';
		options.invalidate();
	}

	watch(() => [form.value.provider, form.value.baseUrl, form.value.allowInsecureTls], () => {
		if (derivedToken) {
			form.value.accessToken = '';
			derivedToken = false;
		}
		invalidate();
	}, { flush: 'sync' });
	watch(() => form.value.provider, () => {
		form.value.playbackReportingEnabled = false;
		form.value.accessToken = '';
		delete form.value.clientIdentifier;
		username.value = '';
		password.value = '';
		method.value = initialMethod();
		passwordVisible.value = false;
	}, { flush: 'sync' });
	watch([() => form.value.accessToken, () => form.value.clientIdentifier, options.typeKey], invalidate, { flush: 'sync' });
	watch([username, password], () => {
		if (!acceptingCredential && derivedToken) {
			form.value.accessToken = '';
			derivedToken = false;
		}
		invalidate();
	}, { flush: 'sync' });
	watch(method, () => {
		derivedToken = false;
		form.value.accessToken = '';
		password.value = '';
		passwordVisible.value = false;
		invalidate();
	}, { flush: 'sync' });

	/** Whether an asynchronous result still belongs to the currently displayed draft. */
	function current(request: number): boolean {
		return !disposed && generation === request;
	}

	/** Accept an issued credential without treating those internal writes as a new user request. */
	function acceptCredential(accessToken: string, clientIdentifier: string): void {
		acceptingCredential = true;
		try {
			form.value.accessToken = accessToken;
			form.value.clientIdentifier = clientIdentifier;
			password.value = '';
			derivedToken = true;
		}
		finally {
			acceptingCredential = false;
		}
	}

	/** Exchange a password when needed, then inspect the exact connection draft without saving it. */
	async function testConnection(): Promise<MediaServerProbeResult | null> {
		if (!canTest.value) {
			return null;
		}

		const request = ++generation;
		testing.value = true;
		error.value = '';
		try {
			if (method.value === 'password' && password.value && form.value.provider !== 'plex') {
				const credential = await api.signInMediaServer({
					provider: form.value.provider,
					baseUrl: form.value.baseUrl.trim(),
					allowInsecureTls: form.value.allowInsecureTls,
					username: username.value.trim(),
					password: password.value,
					...(form.value.clientIdentifier ? { clientIdentifier: form.value.clientIdentifier } : {}),
				});
				if (!current(request)) {
					return null;
				}

				acceptCredential(credential.accessToken ?? '', credential.clientIdentifier);
			}

			const { provider, baseUrl, accessToken, allowInsecureTls, clientIdentifier } = form.value;
			const body = {
				provider, baseUrl: baseUrl.trim(), accessToken: accessToken.trim(), allowInsecureTls,
				...(clientIdentifier ? { clientIdentifier } : {}), typeKey: options.typeKey(),
			};
			const saved = options.saved();
			const result = saved ? await api.probeSavedMediaServer(saved.id, savedMediaServerProbeSchema.parse(body)) : await api.probeMediaServer(body);
			return current(request) ? result : null;
		}
		catch (cause) {
			if (current(request)) {
				error.value = errorMessage(cause);
			}
			return null;
		}
		finally {
			if (current(request)) {
				testing.value = false;
			}
		}
	}

	/** Poll one Plex link while it still belongs to this exact connection draft. */
	async function pollPin(request: number, pinId: number, clientIdentifier: string): Promise<void> {
		try {
			const result = await api.pollPlexPin(pinId, clientIdentifier, form.value.baseUrl.trim());
			if (!current(request)) {
				return;
			}
			if (result.accessToken) {
				acceptCredential(result.accessToken, result.clientIdentifier);
				stopPin();
				return;
			}

			pinTimer = setTimeout(() => void pollPin(request, pinId, clientIdentifier), 2000);
		}
		catch (cause) {
			if (current(request)) {
				error.value = errorMessage(cause);
				stopPin();
			}
		}
	}

	/** Start Plex's link-code flow without persisting its eventual token. */
	async function startPlexPin(): Promise<void> {
		invalidate();
		const request = generation;
		linking.value = true;
		try {
			const pin = await api.createPlexPin(form.value.clientIdentifier || undefined);
			if (!current(request)) {
				return;
			}

			pinCode.value = pin.code;
			void pollPin(request, pin.pinId, pin.clientIdentifier);
		}
		catch (cause) {
			if (current(request)) {
				error.value = errorMessage(cause);
				stopPin();
			}
		}
	}

	onBeforeUnmount(() => {
		disposed = true;
		generation += 1;
		stopPin();
	});
	return { method, username, password, passwordVisible, pinCode, testing, linking, busy, error, authDirty, canTest, testConnection, startPlexPin };
}
