import { describe, expect, it } from 'vitest';
import { authenticationNavigationRedirect, authenticationReturnPath } from '@web/authentication-navigation.js';

describe('authentication navigation boundary', () => {
	it('does not redirect repeated anonymous failures on authentication pages', () => {
		for (const path of ['/login', '/setup', '/recover']) {
			const target = { fullPath: `${path}?returnTo=/libraries/example?anchor=%2523`, meta: { publicAuthentication: true } };
			for (let failure = 0; failure < 3; failure += 1) {
				expect(authenticationNavigationRedirect(false, true, target)).toBeNull();
			}
		}
	});

	it('unwraps legacy nested login URLs without re-decoding the final destination', () => {
		const destination = '/libraries/example?anchor=%23&filter=music%20videos#files';
		let nested = destination;
		for (let depth = 0; depth < 6; depth += 1) {
			nested = `/login?${new URLSearchParams({ returnTo: nested })}`;
		}
		expect(authenticationReturnPath(nested)).toBe(destination);
		expect(authenticationNavigationRedirect(true, true, {
			fullPath: nested,
			meta: { publicAuthentication: true },
		})).toBe(destination);
		expect(authenticationReturnPath('/login?returnTo=/login?returnTo=/libraries/example?anchor=%252523')).toBe('/libraries/example?anchor=%23');
	});

	it('rejects unsafe, missing, and excessively nested destinations', () => {
		for (const value of [null, ['//example.com'], 'https://example.com', '//example.com', '/\\example.com', '/\n/example.com', '/login', '/setup?returnTo=https://example.com']) {
			expect(authenticationReturnPath(value)).toBe('/');
		}
		expect(authenticationReturnPath('/login?returnTo='.repeat(20) + '/settings')).toBe('/');
	});

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
