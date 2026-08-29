import { describe, expect, it } from 'vitest';
import { authenticationNavigationRedirect } from '@web/authentication-navigation.js';

describe('authentication navigation boundary', () => {
	it('allows an authenticated administrator to open recovery', () => {
		expect(authenticationNavigationRedirect(true, true, {
			fullPath: '/recover',
			meta: { publicAuthentication: true, allowAuthenticated: true },
		})).toBeNull();
	});

	it('keeps ordinary sign-in pages anonymous-only', () => {
		expect(authenticationNavigationRedirect(true, true, {
			fullPath: '/login',
			meta: { publicAuthentication: true },
		})).toBe('/');
	});

	it('sends anonymous protected navigation to the appropriate entry page', () => {
		expect(authenticationNavigationRedirect(false, true, {
			fullPath: '/settings?section=playback',
			meta: {},
		})).toEqual({
			path: '/login',
			query: { returnTo: '/settings?section=playback' },
		});
		expect(authenticationNavigationRedirect(false, false, {
			fullPath: '/settings',
			meta: {},
		})).toEqual({ path: '/setup', query: { returnTo: '/settings' } });
	});
});
