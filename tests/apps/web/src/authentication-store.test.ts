import { createPinia, setActivePinia } from 'pinia';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthenticationState } from '@moirai/shared';
import {
	api,
	ApiError,
	beginApiAuthenticationTransition,
	onApiUnauthorized,
	setApiCsrfToken,
} from '@web/api.js';
import { useAuthenticationStore } from '@web/stores/authentication.js';

const authenticatedState: AuthenticationState = {
	status: 'authenticated',
	methods: { local: true, logto: false },
	localUsername: 'administrator',
	identity: {
		id: '6e8352b6-ce50-41a7-a1fc-2a29455589c1',
		provider: 'local',
		displayName: 'Administrator',
		username: 'administrator',
	},
	csrfToken: 'csrf-token',
};

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	onApiUnauthorized(null);
	setApiCsrfToken(null);
});

describe('browser authentication expiry', () => {
	it('notifies the shared expiry listener when logout returns unauthorized', async () => {
		const listener = vi.fn();
		onApiUnauthorized(listener);
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
			code: 'authentication_required',
			message: 'Authentication is required',
			requestId: 'request-id',
		}), {
			status: 401,
			headers: { 'Content-Type': 'application/json' },
		})));

		await expect(api.logout()).rejects.toMatchObject({ status: 401 });
		expect(listener).toHaveBeenCalledOnce();
	});

	it('notifies expiry when the protected credentials endpoint requires authentication', async () => {
		const listener = vi.fn();
		onApiUnauthorized(listener);
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
			code: 'authentication_required',
			message: 'Authentication is required',
			requestId: 'request-id',
		}), {
			status: 401,
			headers: { 'Content-Type': 'application/json' },
		})));

		await expect(api.saveLocalCredentials({
			username: 'administrator',
			password: 'a replacement long password',
			currentPassword: 'the prior long password',
		})).rejects.toMatchObject({ status: 401 });
		expect(listener).toHaveBeenCalledOnce();
	});

	it('ignores stale unauthorized responses that overlap a completed session transition', async () => {
		const listener = vi.fn();
		onApiUnauthorized(listener);
		let resolveResponse!: (response: Response) => void;
		vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise((resolve) => {
			resolveResponse = resolve;
		})));
		const request = api.capabilities();
		const finishTransition = beginApiAuthenticationTransition();
		finishTransition();

		resolveResponse(new Response(JSON.stringify({
			code: 'authentication_required',
			message: 'Authentication is required',
			requestId: 'request-id',
		}), {
			status: 401,
			headers: { 'Content-Type': 'application/json' },
		}));

		await expect(request).rejects.toMatchObject({ status: 401 });
		expect(listener).not.toHaveBeenCalled();
	});

	it('does not expire browser state for an ordinary invalid-credentials response', async () => {
		const listener = vi.fn();
		onApiUnauthorized(listener);
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
			code: 'invalid_credentials',
			message: 'Invalid username or password',
			requestId: 'request-id',
		}), {
			status: 401,
			headers: { 'Content-Type': 'application/json' },
		})));

		await expect(api.login({
			username: 'administrator',
			password: 'the wrong long password',
		})).rejects.toMatchObject({ status: 401 });
		expect(listener).not.toHaveBeenCalled();
	});

	it('clears authenticated store state when an already-revoked session signs out', async () => {
		setActivePinia(createPinia());
		vi.spyOn(api, 'authenticationState').mockResolvedValue(authenticatedState);
		vi.spyOn(api, 'logout').mockRejectedValue(new ApiError({
			code: 'authentication_required',
			message: 'Authentication is required',
			requestId: 'request-id',
		}, 401));
		const authentication = useAuthenticationStore();
		await authentication.load();
		expect(authentication.authenticated).toBe(true);

		await expect(authentication.logout()).resolves.toBeNull();
		expect(authentication.authenticated).toBe(false);
		expect(authentication.state?.status).toBe('anonymous');
		expect(authentication.state?.csrfToken).toBeNull();
	});

	it('adopts authoritative session state after an ambiguous credential-change failure', async () => {
		setActivePinia(createPinia());
		const replacementState: AuthenticationState = {
			...authenticatedState,
			csrfToken: 'replacement-csrf',
		};
		vi.spyOn(api, 'authenticationState')
			.mockResolvedValueOnce(authenticatedState)
			.mockResolvedValueOnce(replacementState);
		vi.spyOn(api, 'saveLocalCredentials').mockRejectedValueOnce(new TypeError('Network failed'));
		const authentication = useAuthenticationStore();
		await authentication.load();

		await expect(authentication.saveLocalCredentials({
			username: 'administrator',
			password: 'a replacement long password',
			currentPassword: 'the prior long password',
		})).rejects.toThrow('Network failed');

		expect(authentication.state?.csrfToken).toBe('replacement-csrf');
	});
});
