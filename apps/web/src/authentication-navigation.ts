/** Authentication-relevant fields selected from one Vue Router navigation target. */
export interface AuthenticationNavigationTarget {
	fullPath: string;
	meta: {
		publicAuthentication?: unknown;
		allowAuthenticated?: unknown;
	};
}

/** Redirect returned by the authentication boundary, or null when navigation may continue. */
export type AuthenticationNavigationRedirect
	= | string
		| { path: string; query: { returnTo: string } }
		| null;

/** Unwrap old nested sign-in destinations while retaining one safe internal URL and its encoding. */
export function authenticationReturnPath(value: unknown): string {
	for (let depth = 0; depth < 16; depth += 1) {
		if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || /[\\\p{Cc}\s]/u.test(value)) {
			return '/';
		}
		const url = new URL(value, 'https://moirai.invalid');
		if (!['/login', '/setup', '/recover'].includes(url.pathname.replace(/\/$/u, '').toLowerCase())) {
			return `${url.pathname}${url.search}${url.hash}`;
		}
		value = url.searchParams.get('returnTo');
	}
	return '/';
}

/** Select the redirect required for current session state and authentication-route metadata. */
export function authenticationNavigationRedirect(
	authenticated: boolean,
	initialized: boolean,
	target: AuthenticationNavigationTarget,
): AuthenticationNavigationRedirect {
	const publicAuthentication = target.meta.publicAuthentication === true;
	const allowAuthenticated = target.meta.allowAuthenticated === true;
	if (authenticated && publicAuthentication && !allowAuthenticated) {
		return authenticationReturnPath(target.fullPath);
	}
	if (!authenticated && !publicAuthentication) {
		const path = initialized ? '/login' : '/setup';
		return { path, query: { returnTo: authenticationReturnPath(target.fullPath) } };
	}

	return null;
}
