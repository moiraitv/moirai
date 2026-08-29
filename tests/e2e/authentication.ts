import { expect, type APIResponse, type Page } from '@playwright/test';

export const E2E_ADMIN_USERNAME = 'e2e-admin';
export const E2E_ADMIN_PASSWORD = 'a sufficiently long e2e password';

interface AuthenticationResult {
	status: 'uninitialized' | 'anonymous' | 'authenticated';
	csrfToken: string | null;
}

/** Establish an isolated browser-context session, claiming first-run setup when necessary. */
export async function authenticateAdministrator(page: Page): Promise<string> {
	const stateResponse = await page.request.get('/api/v1/auth/session');
	expect(stateResponse.ok()).toBe(true);
	const state = await stateResponse.json() as AuthenticationResult;
	let response: APIResponse | null = null;
	if (state.status === 'uninitialized') {
		response = await page.request.post('/api/v1/auth/setup', {
			data: { username: E2E_ADMIN_USERNAME, password: E2E_ADMIN_PASSWORD },
		});
	}

	if (!response?.ok()) {
		response = await page.request.post('/api/v1/auth/login', {
			data: { username: E2E_ADMIN_USERNAME, password: E2E_ADMIN_PASSWORD },
		});
	}

	expect(response.ok()).toBe(true);
	const authenticated = await response.json() as AuthenticationResult;
	expect(authenticated.status).toBe('authenticated');
	expect(authenticated.csrfToken).not.toBeNull();
	return authenticated.csrfToken ?? '';
}
